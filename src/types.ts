export interface ConfluenceSyncSettings {
	deploymentType: "data-center" | "cloud";
	baseUrl: string;
	cloudEmail: string;
	pat: string;
	skipSsl: boolean;
	defaultSpaceKey: string;
	syncFolder: string;
	pullAttachments: boolean;
}

export const DEFAULT_SETTINGS: ConfluenceSyncSettings = {
	deploymentType: "data-center",
	baseUrl: "",
	cloudEmail: "",
	pat: "",
	skipSsl: false,
	defaultSpaceKey: "",
	syncFolder: "confluence-pages",
	pullAttachments: false,
};

export interface ConfluencePage {
	id: string;
	type: string;
	status: string;
	title: string;
	version: {
		number: number;
		when: string;
		by: {
			displayName: string;
		};
	};
	body?: {
		storage: {
			value: string;
		};
	};
	ancestors?: ConfluencePageRef[];
	space?: {
		key: string;
		name?: string;
	};
	metadata?: {
		labels?: {
			results: { name: string }[];
		};
	};
	_links: {
		webui: string;
		self: string;
	};
}

export interface ConfluencePageRef {
	id: string;
	title: string;
	_links: {
		webui: string;
		self: string;
	};
}

export interface ConfluenceSpace {
	id: number;
	key: string;
	name: string;
	type: string;
}

export interface ConfluenceSearchResult {
	results: ConfluencePage[];
	start: number;
	limit: number;
	size: number;
	_links: {
		next?: string;
	};
}

export interface ConfluenceChildrenResult {
	results: ConfluencePageRef[];
	start: number;
	limit: number;
	size: number;
	_links: {
		next?: string;
	};
}

export interface ConfluenceSpacesResult {
	results: ConfluenceSpace[];
	start: number;
	limit: number;
	size: number;
	_links: {
		next?: string;
	};
}

export interface ConfluenceAttachment {
	id: string;
	title: string;
	metadata: {
		mediaType: string;
	};
	_links: {
		download: string;
	};
}

export interface ConfluenceAttachmentsResult {
	results: ConfluenceAttachment[];
	start: number;
	limit: number;
	size: number;
	_links: {
		next?: string;
	};
}

export interface ConfluenceFrontmatter {
	"confluence-id": string;
	"confluence-space": string;
	"confluence-version": number;
	"confluence-title": string;
	"confluence-url": string;
	"confluence-last-pull": string;
	"confluence-author": string;
}

export interface PullResult {
	created: number;
	updated: number;
	skipped: number;
	attachments: number;
	errors: string[];
}

export interface AttachmentPullSummary {
	found: number;
	downloaded: number;
	folder?: string;
}

export interface PagePullResult {
	status: "created" | "updated" | "skipped";
	attachments: AttachmentPullSummary;
}

export interface AttachmentDebugInfo {
	pullAttachmentsEnabled: boolean;
	pageId: string;
	pageTitle: string;
	targetFolder: string;
	apiAttachments: string[];
	storageFilenames: string[];
	storageUrls: string[];
	candidates: {
		title: string;
		downloadPath: string;
		source: string;
	}[];
}
