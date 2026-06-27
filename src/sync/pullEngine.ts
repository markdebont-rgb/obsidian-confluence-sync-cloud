import { Vault, TFile, TFolder } from "obsidian";
import type { ConfluenceClient } from "../api/confluenceClient";
import type { ConfluenceSyncSettings, ConfluencePage, PullResult } from "../types";
import { fetchAllChildren, fetchAllAttachments } from "../api/pagination";
import { confluenceToMarkdown } from "../converter/confluenceToMd";
import { parseConfluenceUrl } from "../utils/urlParser";
import { buildFilePath, buildAttachmentFolder, sanitizeFilename } from "../utils/pathUtils";
import { parseFrontmatter, buildFileContent, updateConfluenceFrontmatter } from "../utils/frontmatter";
import { findFileByConfluenceId, readConfluenceState, findSyncedFiles } from "./syncState";

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
	async pullPage(pageId: string, ancestorTitles: string[] = []): Promise<"created" | "updated" | "skipped"> {
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
				return "skipped";
			}

			// Update existing file
			await this.updateFile(existingFile, page);
			return "updated";
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

		// Convert and create file
		const markdown = confluenceToMarkdown(
			page.body?.storage?.value || "",
			this.settings.baseUrl,
		);

		const fm = this.buildFrontmatter(page);
		const content = buildFileContent(fm, markdown);

		await this.ensureFolderExists(filePath);
		await this.vault.create(filePath, content);

		// Pull attachments if enabled
		if (this.settings.pullAttachments) {
			await this.pullAttachments(page.id, ancestors, page.title);
		}

		return "created";
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
		const res = result || { created: 0, updated: 0, skipped: 0, errors: [] };

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
					res.skipped++;
				} else {
					await this.updateFile(existingFile, page);
					res.updated++;
				}
			} else {
				const filePath = buildFilePath(this.settings.syncFolder, ancestors, page.title, hasChildren);
				const markdown = confluenceToMarkdown(page.body?.storage?.value || "", this.settings.baseUrl);
				const fm = this.buildFrontmatter(page);
				const content = buildFileContent(fm, markdown);
				await this.ensureFolderExists(filePath);
				await this.vault.create(filePath, content);
				res.created++;

				if (this.settings.pullAttachments) {
					await this.pullAttachments(page.id, ancestors, page.title);
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
	async rePullFile(file: TFile): Promise<"updated" | "skipped" | "not-synced"> {
		const state = await readConfluenceState(this.vault, file);
		if (!state) {
			return "not-synced";
		}

		const page = await this.client.getPage(state["confluence-id"]);

		if (page.version.number <= state["confluence-version"]) {
			return "skipped";
		}

		await this.updateFile(file, page);
		return "updated";
	}

	/**
	 * Re-pull all synced files in the sync folder.
	 */
	async rePullAll(onProgress?: (msg: string) => void): Promise<PullResult> {
		const result: PullResult = { created: 0, updated: 0, skipped: 0, errors: [] };
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
					result.skipped++;
				} else {
					await this.updateFile(file, page);
					result.updated++;
				}
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				result.errors.push(`${file.basename}: ${msg}`);
			}
		}

		return result;
	}

	// --- Private helpers ---

	private async updateFile(file: TFile, page: ConfluencePage): Promise<void> {
		const oldContent = await this.vault.read(file);
		const { fm: existingFm } = parseFrontmatter(oldContent);

		const markdown = confluenceToMarkdown(
			page.body?.storage?.value || "",
			this.settings.baseUrl,
		);

		const newFm = updateConfluenceFrontmatter(existingFm, this.buildFrontmatter(page));
		const content = buildFileContent(newFm, markdown);

		await this.vault.modify(file, content);
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
		pageId: string,
		ancestors: string[],
		pageTitle: string,
	): Promise<void> {
		const attachments = await fetchAllAttachments(this.client, pageId);
		if (attachments.length === 0) return;

		const attachFolder = buildAttachmentFolder(
			this.settings.syncFolder,
			ancestors,
			pageTitle,
		);

		for (const att of attachments) {
			try {
				const data = await this.client.downloadAttachment(att._links.download);
				const path = `${attachFolder}/${sanitizeFilename(att.title)}`;
				await this.ensureFolderExists(path);
				await this.vault.createBinary(path, data);
			} catch {
				// Silently skip failed attachments
			}
		}
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
