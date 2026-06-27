import { Vault, TFile, TFolder } from "obsidian";
import type { ConfluenceClient } from "../api/confluenceClient";
import type { ConfluenceSyncSettings, ConfluencePage, PullResult, PagePullResult, AttachmentPullSummary, AttachmentDebugInfo } from "../types";
import { fetchAllChildren, fetchAllAttachments } from "../api/pagination";
import { confluenceToMarkdown } from "../converter/confluenceToMd";
import { parseConfluenceUrl } from "../utils/urlParser";
import { buildFilePath, buildAttachmentFolder, sanitizeFilename } from "../utils/pathUtils";
import { parseFrontmatter, buildFileContent, updateConfluenceFrontmatter } from "../utils/frontmatter";
import { findFileByConfluenceId, readConfluenceState, findSyncedFiles } from "./syncState";

const CONVERTER_VERSION = 2;

interface AttachmentCandidate {
	title: string;
	downloadPath: string;
	source: "api" | "storage-ref" | "storage-url";
}

interface StorageAttachmentRef {
	filename: string;
	pageTitle?: string;
}

export class PullEngine {
	private client: ConfluenceClient;
	private vault: Vault;
	private settings: ConfluenceSyncSettings;

	constructor(client: ConfluenceClient, vault: Vault, settings: ConfluenceSyncSettings) {
		this.client = client;
		this.vault = vault;
		this.settings = settings;
	}

	updateSettings(settings: ConfluenceSyncSettings): void {
		this.settings = settings;
	}

	/**
	 * Resolve a user input (URL, page ID, or title) to a page ID.
	 */
	async resolvePageId(input: string): Promise<string> {
		const parsed = parseConfluenceUrl(input);

		if (parsed.pageId) {
			return parsed.pageId;
		}

		if (parsed.title) {
			const result = await this.client.searchByTitle(
				parsed.title,
				parsed.spaceKey || this.settings.defaultSpaceKey || undefined,
			);
			if (result.results.length === 0) {
				throw new Error(`Page not found: "${parsed.title}"`);
			}
			return result.results[0].id;
		}

		throw new Error("Cannot resolve page from input: " + input);
	}

	/**
	 * Pull a single page by ID.
	 */
	async pullPage(pageId: string, ancestorTitles: string[] = []): Promise<PagePullResult> {
		const page = await this.client.getPage(pageId);

		// Check if already exists
		const existingFile = await findFileByConfluenceId(
			this.vault,
			this.settings.syncFolder,
			page.id,
		);

		if (existingFile) {
			const state = await readConfluenceState(this.vault, existingFile);
			if (state && state["confluence-version"] >= page.version.number) {
				if (await this.needsLocalRewrite(existingFile)) {
					const attachments = await this.updateFile(existingFile, page);
					return { status: "updated", attachments };
				}
				let attachments = this.emptyAttachmentSummary();
				if (this.settings.pullAttachments) {
					attachments = await this.pullAttachmentsForFile(page, existingFile);
				}
				return { status: "skipped", attachments };
			}

			// Update existing file
			const attachments = await this.updateFile(existingFile, page);
			return { status: "updated", attachments };
		}

		// Determine ancestors from API response if not provided
		const ancestors = ancestorTitles.length > 0
			? ancestorTitles
			: this.extractAncestorTitles(page);

		// Check if page has children to determine path structure
		const children = await this.client.getPageChildren(page.id, 0, 1);
		const hasChildren = children.results.length > 0;

		const filePath = buildFilePath(
			this.settings.syncFolder,
			ancestors,
			page.title,
			hasChildren,
		);

		const attachmentFolder = this.settings.pullAttachments
			? buildAttachmentFolder(this.settings.syncFolder, ancestors, page.title)
			: undefined;
		const markdown = await this.renderPageMarkdown(page, attachmentFolder);

		const fm = this.buildFrontmatter(page);
		const content = buildFileContent(fm, markdown);

		await this.ensureFolderExists(filePath);
		await this.vault.create(filePath, content);

		// Pull attachments if enabled
		let attachments = this.emptyAttachmentSummary();
		if (this.settings.pullAttachments) {
			attachments = await this.pullAttachments(page, ancestors);
		}

		return { status: "created", attachments };
	}

	/**
	 * Pull a page and all its descendants recursively.
	 */
	async pullPageTree(
		pageId: string,
		ancestorTitles: string[] = [],
		result?: PullResult,
		onProgress?: (msg: string) => void,
	): Promise<PullResult> {
		const res = result || { created: 0, updated: 0, skipped: 0, attachments: 0, errors: [] };

		try {
			const page = await this.client.getPage(pageId);
			if (onProgress) {
				onProgress(`Pulling: ${page.title}`);
			}

			const ancestors = ancestorTitles.length > 0
				? ancestorTitles
				: this.extractAncestorTitles(page);

			// Pull this page (force hasChildren check)
			const children = await fetchAllChildren(this.client, page.id);
			const hasChildren = children.length > 0;

			const existingFile = await findFileByConfluenceId(
				this.vault,
				this.settings.syncFolder,
				page.id,
			);

			if (existingFile) {
				const state = await readConfluenceState(this.vault, existingFile);
				if (state && state["confluence-version"] >= page.version.number) {
					if (await this.needsLocalRewrite(existingFile)) {
						const attachments = await this.updateFile(existingFile, page);
						res.attachments += attachments.downloaded;
						res.updated++;
					} else if (this.settings.pullAttachments) {
						const attachments = await this.pullAttachmentsForFile(page, existingFile);
						res.attachments += attachments.downloaded;
						res.skipped++;
					} else {
						res.skipped++;
					}
				} else {
					const attachments = await this.updateFile(existingFile, page);
					res.attachments += attachments.downloaded;
					res.updated++;
				}
			} else {
				const filePath = buildFilePath(this.settings.syncFolder, ancestors, page.title, hasChildren);
				const attachmentFolder = this.settings.pullAttachments
					? buildAttachmentFolder(this.settings.syncFolder, ancestors, page.title)
					: undefined;
				const markdown = await this.renderPageMarkdown(page, attachmentFolder);
				const fm = this.buildFrontmatter(page);
				const content = buildFileContent(fm, markdown);
				await this.ensureFolderExists(filePath);
				await this.vault.create(filePath, content);
				res.created++;

				if (this.settings.pullAttachments) {
					const attachments = await this.pullAttachments(page, ancestors);
					res.attachments += attachments.downloaded;
				}
			}

			// Recurse into children
			const childAncestors = [...ancestors, page.title];
			for (const child of children) {
				await this.pullPageTree(child.id, childAncestors, res, onProgress);
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			res.errors.push(`Page ${pageId}: ${msg}`);
		}

		return res;
	}

	/**
	 * Re-pull (update) a single file from Confluence.
	 */
	async rePullFile(file: TFile): Promise<PagePullResult | "not-synced"> {
		const state = await readConfluenceState(this.vault, file);
		if (!state) {
			return "not-synced";
		}

		const page = await this.client.getPage(state["confluence-id"]);

		if (page.version.number <= state["confluence-version"]) {
			if (await this.needsLocalRewrite(file)) {
				const attachments = await this.updateFile(file, page);
				return { status: "updated", attachments };
			}
			let attachments = this.emptyAttachmentSummary();
			if (this.settings.pullAttachments) {
				attachments = await this.pullAttachmentsForFile(page, file);
			}
			return { status: "skipped", attachments };
		}

		const attachments = await this.updateFile(file, page);
		return { status: "updated", attachments };
	}

	/**
	 * Re-pull all synced files in the sync folder.
	 */
	async rePullAll(onProgress?: (msg: string) => void): Promise<PullResult> {
		const result: PullResult = { created: 0, updated: 0, skipped: 0, attachments: 0, errors: [] };
		const files = findSyncedFiles(this.vault, this.settings.syncFolder);

		let processed = 0;
		for (const file of files) {
			processed++;
			try {
				const state = await readConfluenceState(this.vault, file);
				if (!state) continue;

				if (onProgress) {
					onProgress(`Checking ${processed}/${files.length}: ${file.basename}`);
				}

				const page = await this.client.getPage(state["confluence-id"]);
				if (page.version.number <= state["confluence-version"]) {
					if (await this.needsLocalRewrite(file)) {
						const attachments = await this.updateFile(file, page);
						result.attachments += attachments.downloaded;
						result.updated++;
						continue;
					}
					if (this.settings.pullAttachments) {
						const attachments = await this.pullAttachmentsForFile(page, file);
						result.attachments += attachments.downloaded;
					}
					result.skipped++;
				} else {
					const attachments = await this.updateFile(file, page);
					result.attachments += attachments.downloaded;
					result.updated++;
				}
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				result.errors.push(`${file.basename}: ${msg}`);
			}
		}

		return result;
	}

	async debugAttachmentsForFile(file: TFile): Promise<AttachmentDebugInfo | "not-synced"> {
		const state = await readConfluenceState(this.vault, file);
		if (!state) {
			return "not-synced";
		}

		const page = await this.client.getPage(state["confluence-id"]);
		const apiAttachments = await fetchAllAttachments(this.client, page.id);
		const storageUrls = this.extractAttachmentUrls(page.body?.storage?.value || "");
		const candidates = await this.getAttachmentCandidates(page);

		return {
			pullAttachmentsEnabled: this.settings.pullAttachments,
			pageId: page.id,
			pageTitle: page.title,
			targetFolder: this.buildAttachmentFolderForFile(file, page.title),
			apiAttachments: apiAttachments.map((attachment) => attachment.title),
			storageFilenames: this.extractAttachmentFilenames(page.body?.storage?.value || ""),
			storageUrls: storageUrls.map((attachmentUrl) => attachmentUrl.downloadPath),
			candidates: candidates.map((candidate) => ({
				title: candidate.title,
				downloadPath: candidate.downloadPath,
				source: candidate.source,
			})),
		};
	}

	// --- Private helpers ---

	private async updateFile(file: TFile, page: ConfluencePage): Promise<AttachmentPullSummary> {
		const oldContent = await this.vault.read(file);
		const { fm: existingFm } = parseFrontmatter(oldContent);
		const attachmentFolder = this.settings.pullAttachments
			? this.buildAttachmentFolderForFile(file, page.title)
			: undefined;

		const markdown = await this.renderPageMarkdown(page, attachmentFolder);

		const newFm = updateConfluenceFrontmatter(existingFm, this.buildFrontmatter(page));
		const content = buildFileContent(newFm, markdown);

		await this.vault.modify(file, content);

		if (this.settings.pullAttachments) {
			return this.pullAttachmentsForFile(page, file);
		}

		return this.emptyAttachmentSummary();
	}

	private async renderPageMarkdown(
		page: ConfluencePage,
		attachmentFolder?: string,
	): Promise<string> {
		let markdown = confluenceToMarkdown(
			page.body?.storage?.value || "",
			this.settings.baseUrl,
			attachmentFolder,
		);

		if (this.settings.pullAttachments && attachmentFolder) {
			const candidates = await this.getAttachmentCandidates(page);
			const missingLinks = candidates
				.map((candidate) => this.formatAttachmentEmbed(candidate.title, attachmentFolder))
				.filter((link) => !markdown.includes(link));

			if (missingLinks.length > 0) {
				markdown = [
					markdown,
					"",
					"## Attachments",
					"",
					...missingLinks,
				].join("\n");
			}
		}

		return markdown;
	}

	private formatAttachmentEmbed(filename: string, attachmentFolder: string): string {
		return `![[${attachmentFolder}/${sanitizeFilename(filename)}]]`;
	}

	private buildFrontmatter(page: ConfluencePage): Record<string, string | number> {
		const spaceKey = page.space?.key || this.settings.defaultSpaceKey;

		return {
			"confluence-id": page.id,
			"confluence-space": spaceKey,
			"confluence-version": page.version.number,
			"confluence-title": page.title,
			"confluence-url": this.client.getPageUrl(page.id),
			"confluence-last-pull": new Date().toISOString(),
			"confluence-author": page.version.by?.displayName || "",
			"confluence-converter": CONVERTER_VERSION,
		};
	}

	private extractAncestorTitles(page: ConfluencePage): string[] {
		if (!page.ancestors || page.ancestors.length === 0) {
			return [];
		}
		// Skip the first ancestor (usually the space root page)
		return page.ancestors.slice(1).map((a) => a.title);
	}

	private async pullAttachments(
		page: ConfluencePage,
		ancestors: string[],
	): Promise<AttachmentPullSummary> {
		const attachFolder = buildAttachmentFolder(
			this.settings.syncFolder,
			ancestors,
			page.title,
		);
		return this.pullAttachmentsToFolder(page, attachFolder);
	}

	private async pullAttachmentsForFile(
		page: ConfluencePage,
		file: TFile,
	): Promise<AttachmentPullSummary> {
		const attachFolder = this.buildAttachmentFolderForFile(file, page.title);
		return this.pullAttachmentsToFolder(page, attachFolder);
	}

	private async pullAttachmentsToFolder(
		page: ConfluencePage,
		attachFolder: string,
	): Promise<AttachmentPullSummary> {
		const attachments = await this.getAttachmentCandidates(page);
		if (attachments.length === 0) {
			return { found: 0, downloaded: 0, folder: attachFolder };
		}

		const errors: string[] = [];
		let downloaded = 0;

		for (const att of attachments) {
			try {
				const data = await this.client.downloadAttachment(att.downloadPath);
				const path = `${attachFolder}/${sanitizeFilename(att.title)}`;
				await this.ensureFolderExists(path);
				await this.writeBinaryFile(path, data);
				downloaded++;
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				errors.push(`${att.title} [${att.source}] ${att.downloadPath}: ${msg}`);
			}
		}

		if (errors.length > 0) {
			throw new Error(`Failed to pull ${errors.length} attachment(s): ${errors.join("; ")}`);
		}

		return { found: attachments.length, downloaded, folder: attachFolder };
	}

	private emptyAttachmentSummary(): AttachmentPullSummary {
		return { found: 0, downloaded: 0 };
	}

	private async getAttachmentCandidates(page: ConfluencePage): Promise<AttachmentCandidate[]> {
		const byTitle = new Map<string, AttachmentCandidate>();
		const apiAttachments = await fetchAllAttachments(this.client, page.id);

		for (const attachment of apiAttachments) {
			byTitle.set(attachment.title, {
				title: attachment.title,
				downloadPath: attachment._links.download,
				source: "api",
			});
		}

		for (const attachmentRef of this.extractAttachmentRefs(page.body?.storage?.value || "")) {
			if (!byTitle.has(attachmentRef.filename)) {
				const containerPageId = await this.resolveAttachmentContainerPageId(page, attachmentRef);
				byTitle.set(attachmentRef.filename, {
					title: attachmentRef.filename,
					downloadPath: this.client.getAttachmentDownloadPath(containerPageId, attachmentRef.filename),
					source: "storage-ref",
				});
			}
		}

		for (const attachmentUrl of this.extractAttachmentUrls(page.body?.storage?.value || "")) {
			if (!byTitle.has(attachmentUrl.filename)) {
				byTitle.set(attachmentUrl.filename, {
					title: attachmentUrl.filename,
					downloadPath: attachmentUrl.downloadPath,
					source: "storage-url",
				});
			}
		}

		return Array.from(byTitle.values());
	}

	private extractAttachmentFilenames(storageFormat: string): string[] {
		return this.extractAttachmentRefs(storageFormat).map((attachmentRef) => attachmentRef.filename);
	}

	private extractAttachmentRefs(storageFormat: string): StorageAttachmentRef[] {
		const normalized = storageFormat
			.replace(/<(\/?)ri:/g, "<$1ri-")
			.replace(/\bri:([A-Za-z0-9_-]+)=/g, "ri-$1=");
		const refs = new Map<string, StorageAttachmentRef>();
		for (const match of normalized.matchAll(/<ri-attachment\b[^>]*(?:\/>|>[\s\S]*?<\/ri-attachment>)/gi)) {
			const attachmentTag = match[0];
			const filename = this.getHtmlAttribute(attachmentTag, "ri-filename");
			if (!filename) {
				continue;
			}
			const pageTitle = this.getHtmlAttribute(attachmentTag, "ri-content-title");
			const key = `${filename}\u0000${pageTitle || ""}`;
			refs.set(key, {
				filename,
				...(pageTitle ? { pageTitle } : {}),
			});
		}
		return Array.from(refs.values());
	}

	private async resolveAttachmentContainerPageId(
		page: ConfluencePage,
		attachmentRef: StorageAttachmentRef,
	): Promise<string> {
		if (!attachmentRef.pageTitle || attachmentRef.pageTitle === page.title) {
			return page.id;
		}

		try {
			const result = await this.client.searchByTitle(
				attachmentRef.pageTitle,
				page.space?.key || this.settings.defaultSpaceKey || undefined,
			);
			return result.results[0]?.id || page.id;
		} catch {
			return page.id;
		}
	}

	private extractAttachmentUrls(storageFormat: string): { filename: string; downloadPath: string }[] {
		const normalized = storageFormat
			.replace(/<(\/?)ri:/g, "<$1ri-")
			.replace(/\bri:([A-Za-z0-9_-]+)=/g, "ri-$1=");
		const urls = new Map<string, string>();
		for (const match of normalized.matchAll(/\b(?:ri-value|src)\s*=\s*(['"])(.*?)\1/gi)) {
			const rawUrl = this.decodeBasicHtmlEntities(match[2]);
			if (!rawUrl.includes("/download/attachments/")) {
				continue;
			}

			const parsed = this.parseAttachmentDownloadUrl(rawUrl);
			if (parsed) {
				urls.set(parsed.filename, parsed.downloadPath);
			}
		}
		return Array.from(urls, ([filename, downloadPath]) => ({ filename, downloadPath }));
	}

	private parseAttachmentDownloadUrl(rawUrl: string): { filename: string; downloadPath: string } | null {
		try {
			const url = rawUrl.startsWith("http")
				? new URL(rawUrl)
				: new URL(rawUrl, "https://placeholder.local");
			const match = url.pathname.match(/(?:\/wiki)?\/download\/attachments\/[^/]+\/([^/]+)/);
			if (!match) {
				return null;
			}
			return {
				filename: decodeURIComponent(match[1]),
				downloadPath: url.pathname + url.search,
			};
		} catch {
			return null;
		}
	}

	private decodeBasicHtmlEntities(value: string): string {
		return value
			.replace(/&quot;/g, "\"")
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">");
	}

	private getHtmlAttribute(html: string, attributeName: string): string | null {
		const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = html.match(new RegExp(`\\b${escapedName}\\s*=\\s*(['"])(.*?)\\1`, "i"));
		return match ? this.decodeBasicHtmlEntities(match[2]) : null;
	}

	private async needsLocalRewrite(file: TFile): Promise<boolean> {
		const content = await this.vault.read(file);
		const { fm } = parseFrontmatter(content);
		return content.includes("<!-- confluence:") ||
			Number(fm["confluence-converter"] || 0) < CONVERTER_VERSION;
	}

	private buildAttachmentFolderForFile(file: TFile, pageTitle: string): string {
		const parentPath = file.parent?.path || "";
		const safeTitle = sanitizeFilename(pageTitle);
		if (file.basename === safeTitle && parentPath.endsWith(`/${safeTitle}`)) {
			return `${parentPath}/_attachments`;
		}
		return parentPath
			? `${parentPath}/${safeTitle}/_attachments`
			: `${safeTitle}/_attachments`;
	}

	private async writeBinaryFile(path: string, data: ArrayBuffer): Promise<void> {
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, data);
			return;
		}

		await this.vault.createBinary(path, data);
	}

	private async ensureFolderExists(filePath: string): Promise<void> {
		const folderPath = filePath.substring(0, filePath.lastIndexOf("/"));
		if (!folderPath) return;

		const existing = this.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) return;

		// Create folders recursively
		const parts = folderPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? current + "/" + part : part;
			const folder = this.vault.getAbstractFileByPath(current);
			if (!folder) {
				await this.vault.createFolder(current);
			}
		}
	}
}
