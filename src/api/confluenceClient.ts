import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { ConfluenceSyncSettings, ConfluencePage, ConfluenceSpacesResult, ConfluenceChildrenResult, ConfluenceAttachmentsResult, ConfluenceSearchResult } from "../types";

export class ConfluenceClient {
	private settings: ConfluenceSyncSettings;

	constructor(settings: ConfluenceSyncSettings) {
		this.settings = settings;
	}

	updateSettings(settings: ConfluenceSyncSettings): void {
		this.settings = settings;
	}

	private get apiBase(): string {
		if (this.settings.deploymentType === "cloud") {
			return this.siteBase + "/wiki/rest/api";
		}
		return this.dataCenterBase + "/rest/api";
	}

	private get dataCenterBase(): string {
		return this.settings.baseUrl.replace(/\/+$/, "");
	}

	private get siteBase(): string {
		return this.settings.baseUrl.replace(/\/wiki\/?$/, "").replace(/\/+$/, "");
	}

	private get webBase(): string {
		if (this.settings.deploymentType === "cloud") {
			return this.siteBase + "/wiki";
		}
		return this.dataCenterBase;
	}

	private get authHeaders(): Record<string, string> {
		if (this.settings.deploymentType === "cloud") {
			return {
				"Authorization": `Basic ${encodeBasicAuth(this.settings.cloudEmail, this.settings.pat)}`,
			};
		}

		return {
			"Authorization": `Bearer ${this.settings.pat}`,
		};
	}

	private async request(path: string, params?: Record<string, string>): Promise<RequestUrlResponse> {
		const url = new URL(path.startsWith("http") ? path : this.apiBase + path);
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
		}

		const reqParams: RequestUrlParam = {
			url: url.toString(),
			method: "GET",
			headers: {
				...this.authHeaders,
				"Accept": "application/json",
			},
		};

		return requestUrl(reqParams);
	}

	async testConnection(): Promise<ConfluenceSpacesResult> {
		const resp = await this.request("/space", { limit: "10" });
		return resp.json as ConfluenceSpacesResult;
	}

	async getSpaces(start = 0, limit = 100): Promise<ConfluenceSpacesResult> {
		const resp = await this.request("/space", {
			start: String(start),
			limit: String(limit),
		});
		return resp.json as ConfluenceSpacesResult;
	}

	async getPage(id: string): Promise<ConfluencePage> {
		const resp = await this.request(`/content/${id}`, {
			expand: "body.storage,version,metadata.labels,ancestors,space",
		});
		return resp.json as ConfluencePage;
	}

	async getPageChildren(id: string, start = 0, limit = 100): Promise<ConfluenceChildrenResult> {
		const resp = await this.request(`/content/${id}/child/page`, {
			start: String(start),
			limit: String(limit),
		});
		return resp.json as ConfluenceChildrenResult;
	}

	async getPageAttachments(id: string, start = 0, limit = 100): Promise<ConfluenceAttachmentsResult> {
		const resp = await this.request(`/content/${id}/child/attachment`, {
			start: String(start),
			limit: String(limit),
		});
		return resp.json as ConfluenceAttachmentsResult;
	}

	async searchByTitle(title: string, spaceKey?: string): Promise<ConfluenceSearchResult> {
		const safeTitle = escapeCql(title);
		let cql = `title="${safeTitle}" AND type=page`;
		if (spaceKey) {
			cql += ` AND space.key="${escapeCql(spaceKey)}"`;
		}
		const resp = await this.request("/content/search", { cql });
		return resp.json as ConfluenceSearchResult;
	}

	async searchByCql(cql: string): Promise<ConfluenceSearchResult> {
		const resp = await this.request("/content/search", { cql });
		return resp.json as ConfluenceSearchResult;
	}

	async downloadAttachment(downloadPath: string): Promise<ArrayBuffer> {
		const url = this.resolveDownloadUrl(downloadPath);
		const resp = await requestUrl({
			url,
			method: "GET",
			headers: {
				...this.authHeaders,
			},
		});
		return resp.arrayBuffer;
	}

	getPageUrl(pageId: string): string {
		return `${this.webBase}/pages/viewpage.action?pageId=${pageId}`;
	}

	getAttachmentDownloadPath(pageId: string, filename: string): string {
		const path = `/download/attachments/${encodeURIComponent(pageId)}/${encodeURIComponent(filename)}`;
		if (this.settings.deploymentType === "cloud") {
			return `${path}?api=v2`;
		}
		return path;
	}

	private resolveDownloadUrl(downloadPath: string): string {
		if (downloadPath.startsWith("http")) {
			return downloadPath;
		}

		if (this.settings.deploymentType === "cloud") {
			if (downloadPath.startsWith("/wiki/")) {
				return this.siteBase + downloadPath;
			}
			return this.webBase + downloadPath;
		}

		return this.dataCenterBase + downloadPath;
	}
}

function escapeCql(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function encodeBasicAuth(email: string, apiToken: string): string {
	const value = `${email}:${apiToken}`;
	if (typeof Buffer !== "undefined") {
		return Buffer.from(value, "utf8").toString("base64");
	}
	return btoa(unescape(encodeURIComponent(value)));
}
