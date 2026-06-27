import TurndownService from "turndown";
import { sanitizeFilename } from "../utils/pathUtils";

type TNode = TurndownService.Node;

// Convert Confluence Storage Format HTML to Markdown.
// Handles ac:/ri: namespace prefixes, code macros, links, images, callouts, TOC, unknown macros.
export function confluenceToMarkdown(
	storageFormat: string,
	baseUrl: string,
	attachmentFolder?: string,
): string {
	// Replace namespace colons with dashes so DOMParser can handle them
	const sanitized = storageFormat
		.replace(/<(\/?)ac:/g, "<$1ac-")
		.replace(/<(\/?)ri:/g, "<$1ri-")
		.replace(/\b(ac|ri):([A-Za-z0-9_-]+)=/g, "$1-$2=");

	const withCodeMacros = replaceCodeMacros(sanitized);
	const withImageMacros = replaceImageMacros(withCodeMacros, attachmentFolder);
	const withAttachmentMacros = replaceAttachmentMacros(withImageMacros, attachmentFolder);
	const turndown = createTurndownService(baseUrl, attachmentFolder);
	const markdown = turndown.turndown(withAttachmentMacros);

	// Clean up excessive blank lines
	return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function createTurndownService(baseUrl: string, attachmentFolder?: string): TurndownService {
	const td = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "*",
	});

	// --- Preprocessed attachment macro placeholders ---
	td.addRule("confluenceAttachmentPlaceholder", {
		filter(node: TNode): boolean {
			return (node as HTMLElement).hasAttribute?.("data-confluence-attachment") || false;
		},
		replacement(_content: string, node: TNode): string {
			const value = (node as HTMLElement).getAttribute("data-confluence-attachment") || "";
			return `\n${decodeURIComponent(value)}\n`;
		},
	});

	// --- Preprocessed code macro placeholders ---
	td.addRule("confluenceCodePlaceholder", {
		filter(node: TNode): boolean {
			return (node as HTMLElement).hasAttribute?.("data-confluence-code") || false;
		},
		replacement(_content: string, node: TNode): string {
			const value = (node as HTMLElement).getAttribute("data-confluence-code") || "";
			const language = (node as HTMLElement).getAttribute("data-confluence-language") || "";
			return `\n\`\`\`${decodeURIComponent(language)}\n${decodeURIComponent(value)}\n\`\`\`\n`;
		},
	});

	// --- Code macro -> fenced code block ---
	td.addRule("confluenceCodeMacro", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-structured-macro") &&
				(node as HTMLElement).getAttribute("ac-name") === "code";
		},
		replacement(_content: string, node: TNode): string {
			const el = node as HTMLElement;
			const lang = getParamValue(el, "language") || "";
			const bodyEl = el.querySelector("ac-plain-text-body");
			const code = bodyEl?.textContent || "";
			return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
		},
	});

	// --- Info/Note/Warning/Tip macros -> Obsidian callouts ---
	const calloutTypes = ["info", "note", "warning", "tip"];
	td.addRule("confluenceCalloutMacros", {
		filter(node: TNode): boolean {
			if (!isTag(node, "ac-structured-macro")) return false;
			const name = (node as HTMLElement).getAttribute("ac-name") || "";
			return calloutTypes.includes(name);
		},
		replacement(content: string, node: TNode): string {
			const el = node as HTMLElement;
			const macroName = el.getAttribute("ac-name") || "info";
			const calloutType = macroName === "warning" ? "warning" : macroName;
			const title = getParamValue(el, "title") || "";
			const bodyEl = el.querySelector("ac-rich-text-body");
			const bodyContent = bodyEl ? td.turndown(bodyEl.innerHTML) : content;

			const lines = bodyContent.split("\n").map((l: string) => `> ${l}`);
			const header = title
				? `> [!${calloutType}] ${title}`
				: `> [!${calloutType}]`;
			return `\n${header}\n${lines.join("\n")}\n`;
		},
	});

	// --- Table of Contents macro -> [TOC] ---
	td.addRule("confluenceToc", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-structured-macro") &&
				(node as HTMLElement).getAttribute("ac-name") === "toc";
		},
		replacement(): string {
			return "\n[TOC]\n";
		},
	});

	// --- Expand macro -> details/summary ---
	td.addRule("confluenceExpand", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-structured-macro") &&
				(node as HTMLElement).getAttribute("ac-name") === "expand";
		},
		replacement(content: string, node: TNode): string {
			const el = node as HTMLElement;
			const title = getParamValue(el, "title") || "Click to expand";
			const bodyEl = el.querySelector("ac-rich-text-body");
			const bodyContent = bodyEl ? td.turndown(bodyEl.innerHTML) : content;
			return `\n<details>\n<summary>${title}</summary>\n\n${bodyContent}\n\n</details>\n`;
		},
	});

	// --- ac-link -> wikilink or markdown link ---
	td.addRule("confluenceLink", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-link");
		},
		replacement(_content: string, node: TNode): string {
			const el = node as HTMLElement;
			const pageRef = el.querySelector("ri-page");
			const attachmentRef = el.querySelector("ri-attachment");
			const linkBody = el.querySelector("ac-link-body, ac-plain-text-link-body");
			const linkText = linkBody?.textContent || "";

			if (pageRef) {
				const pageTitle = pageRef.getAttribute("ri-content-title") || "";
				if (linkText && linkText !== pageTitle) {
					return `[[${pageTitle}|${linkText}]]`;
				}
				return `[[${pageTitle}]]`;
			}

			if (attachmentRef) {
				const filename = attachmentRef.getAttribute("ri-filename") || "";
				return formatAttachmentWikilink(filename, attachmentFolder, false);
			}

			// URL link
			const anchor = el.getAttribute("ac-anchor") || "";
			if (anchor) {
				return linkText ? `[${linkText}](#${anchor})` : `[#${anchor}](#${anchor})`;
			}

			return linkText || "";
		},
	});

	// --- ac-image -> image embed ---
	td.addRule("confluenceImage", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-image");
		},
		replacement(_content: string, node: TNode): string {
			const el = node as HTMLElement;
			const attachmentRef = el.querySelector("ri-attachment");
			const urlRef = el.querySelector("ri-url");
			const alt = el.getAttribute("ac-alt") || "";

			if (urlRef) {
				const url = urlRef.getAttribute("ri-value") || "";
				return `![${alt}](${url})`;
			}

			if (attachmentRef) {
				const filename = attachmentRef.getAttribute("ri-filename") || "";
				return formatAttachmentWikilink(filename, attachmentFolder, true);
			}

			return `![${alt}]()`;
		},
	});

	// --- Raw img tags that point at Confluence attachment downloads ---
	td.addRule("confluenceDownloadImage", {
		filter(node: TNode): boolean {
			if (!isTag(node, "img")) return false;
			const src = (node as HTMLElement).getAttribute("src") || "";
			return src.includes("/download/attachments/");
		},
		replacement(_content: string, node: TNode): string {
			const el = node as HTMLElement;
			const src = el.getAttribute("src") || "";
			const filename = getAttachmentFilenameFromUrl(src);
			if (!filename) {
				const alt = el.getAttribute("alt") || "";
				return `![${alt}](${src})`;
			}
			return formatAttachmentWikilink(filename, attachmentFolder, true);
		},
	});

	// --- Raw links that point at Confluence attachment downloads ---
	td.addRule("confluenceDownloadLink", {
		filter(node: TNode): boolean {
			if (!isTag(node, "a")) return false;
			const href = (node as HTMLElement).getAttribute("href") || "";
			return href.includes("/download/attachments/");
		},
		replacement(content: string, node: TNode): string {
			const href = (node as HTMLElement).getAttribute("href") || "";
			const filename = getAttachmentFilenameFromUrl(href);
			if (!filename) {
				return content ? `[${content}](${href})` : href;
			}
			return formatAttachmentWikilink(filename, attachmentFolder, false);
		},
	});

	// --- Emoticon macro ---
	td.addRule("confluenceEmoticon", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-emoticon");
		},
		replacement(_content: string, node: TNode): string {
			const el = node as HTMLElement;
			const name = el.getAttribute("ac-name") || "";
			const emojiMap: Record<string, string> = {
				smile: ":)",
				sad: ":(",
				"thumbs-up": ":+1:",
				"thumbs-down": ":-1:",
				warning: "!",
				tick: "v",
				cross: "x",
				information: "i",
				question: "?",
			};
			return emojiMap[name] || `:${name}:`;
		},
	});

	// --- Status macro -> badge-like text ---
	td.addRule("confluenceStatus", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-structured-macro") &&
				(node as HTMLElement).getAttribute("ac-name") === "status";
		},
		replacement(_content: string, node: TNode): string {
			const el = node as HTMLElement;
			const title = getParamValue(el, "title") || "STATUS";
			return `**[${title}]**`;
		},
	});

	// --- Panel macro -> blockquote ---
	td.addRule("confluencePanel", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-structured-macro") &&
				(node as HTMLElement).getAttribute("ac-name") === "panel";
		},
		replacement(content: string, node: TNode): string {
			const el = node as HTMLElement;
			const bodyEl = el.querySelector("ac-rich-text-body");
			const bodyContent = bodyEl ? td.turndown(bodyEl.innerHTML) : content;
			const lines = bodyContent.split("\n").map((l: string) => `> ${l}`);
			return `\n${lines.join("\n")}\n`;
		},
	});

	// --- Attachment preview/file macros -> attachment embed or link ---
	td.addRule("confluenceAttachmentMacro", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-structured-macro") &&
				(node as HTMLElement).querySelector("ri-attachment") !== null;
		},
		replacement(_content: string, node: TNode): string {
			const el = node as HTMLElement;
			const macroName = el.getAttribute("ac-name") || "";
			const embed = shouldEmbedAttachmentMacro(macroName);
			const links = Array.from(el.querySelectorAll("ri-attachment"))
				.map((attachmentRef) => attachmentRef.getAttribute("ri-filename") || "")
				.filter((filename) => filename.length > 0)
				.map((filename) => formatAttachmentWikilink(filename, attachmentFolder, embed));

			return links.length > 0 ? `\n${links.join("\n")}\n` : "";
		},
	});

	// --- Catch-all: unknown ac-structured-macro -> HTML comment ---
	td.addRule("confluenceUnknownMacro", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-structured-macro");
		},
		replacement(content: string, node: TNode): string {
			const el = node as HTMLElement;
			const name = el.getAttribute("ac-name") || "unknown";
			const bodyEl = el.querySelector("ac-rich-text-body");
			const bodyContent = bodyEl ? td.turndown(bodyEl.innerHTML) : content;
			if (bodyContent.trim()) {
				return `\n<!-- confluence:${name} -->\n${bodyContent}\n<!-- /confluence:${name} -->\n`;
			}
			return `\n<!-- confluence:${name} -->\n`;
		},
	});

	// --- Remove ri-* elements that leak through ---
	td.addRule("removeRiElements", {
		filter(node: TNode): boolean {
			const tag = node.nodeName.toLowerCase();
			return tag.startsWith("ri-");
		},
		replacement(): string {
			return "";
		},
	});

	// --- Remove ac-parameter elements ---
	td.addRule("removeAcParameter", {
		filter(node: TNode): boolean {
			return isTag(node, "ac-parameter");
		},
		replacement(): string {
			return "";
		},
	});

	return td;
}

function isTag(node: TNode, tagName: string): boolean {
	return node.nodeName.toLowerCase() === tagName;
}

function getParamValue(el: HTMLElement, paramName: string): string | null {
	const param = el.querySelector(`ac-parameter[ac-name="${paramName}"]`);
	return param?.textContent || null;
}

function formatAttachmentWikilink(
	filename: string,
	attachmentFolder: string | undefined,
	embed: boolean,
): string {
	const safeFilename = sanitizeFilename(filename);
	const target = attachmentFolder
		? `${attachmentFolder}/${safeFilename}`
		: safeFilename;
	return `${embed ? "!" : ""}[[${target}]]`;
}

function shouldEmbedAttachmentMacro(macroName: string): boolean {
	const previewMacros = new Set([
		"view-file",
		"viewdoc",
		"viewpdf",
		"viewppt",
		"viewxls",
		"office-word",
		"office-excel",
		"office-powerpoint",
		"multimedia",
	]);
	return previewMacros.has(macroName);
}

function replaceCodeMacros(html: string): string {
	return html.replace(
		/<ac-structured-macro\b[^>]*\bac-name=(['"])code\1[^>]*>[\s\S]*?<\/ac-structured-macro>/g,
		(macro) => {
			const language = getMacroParameter(macro, "language") || "";
			const code = extractPlainTextBody(macro) || extractPreText(macro) || "";
			return `<pre data-confluence-code="${encodeURIComponent(code)}" data-confluence-language="${encodeURIComponent(language)}">code</pre>`;
		},
	);
}

function replaceAttachmentMacros(html: string, attachmentFolder?: string): string {
	return html.replace(
		/<ac-structured-macro\b[^>]*>[\s\S]*?<\/ac-structured-macro>/g,
		(macro) => {
			if (!macro.includes("<ri-attachment")) {
				return macro;
			}

			const macroName = getHtmlAttribute(macro, "ac-name") || "";
			const embed = shouldEmbedAttachmentMacro(macroName);
			const links = Array.from(macro.matchAll(/<ri-attachment\b[^>]*>/g))
				.map((match) => getHtmlAttribute(match[0], "ri-filename") || "")
				.filter((filename) => filename.length > 0)
				.map((filename) => formatAttachmentWikilink(filename, attachmentFolder, embed));

			return links.length > 0
				? `<p data-confluence-attachment="${encodeURIComponent(links.join("\n"))}">attachment</p>`
				: macro;
		},
	);
}

function replaceImageMacros(html: string, attachmentFolder?: string): string {
	return html.replace(
		/<ac-image\b[^>]*>[\s\S]*?<\/ac-image>/g,
		(imageMacro) => {
			const attachmentTag = imageMacro.match(/<ri-attachment\b[^>]*>/i)?.[0];
			if (attachmentTag) {
				const filename = getHtmlAttribute(attachmentTag, "ri-filename") || "";
				if (filename) {
					const link = formatAttachmentWikilink(filename, attachmentFolder, true);
					return `<p data-confluence-attachment="${encodeURIComponent(link)}">attachment</p>`;
				}
			}

			const urlTag = imageMacro.match(/<ri-url\b[^>]*>/i)?.[0];
			if (urlTag) {
				const url = getHtmlAttribute(urlTag, "ri-value") || "";
				if (url) {
					const alt = getHtmlAttribute(imageMacro, "ac-alt") || "";
					return `<p>![${alt}](${url})</p>`;
				}
			}

			return imageMacro;
		},
	);
}

function getMacroParameter(macro: string, parameterName: string): string | null {
	const escapedName = parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = macro.match(new RegExp(
		`<ac-parameter\\b[^>]*\\bac-name=(['"])${escapedName}\\1[^>]*>([\\s\\S]*?)<\\/ac-parameter>`,
		"i",
	));
	return match ? decodeBasicHtmlEntities(stripTags(match[2]).trim()) : null;
}

function extractPlainTextBody(macro: string): string | null {
	const match = macro.match(/<ac-plain-text-body\b[^>]*>([\s\S]*?)<\/ac-plain-text-body>/i);
	if (!match) {
		return null;
	}
	return decodeCdata(decodeBasicHtmlEntities(match[1]));
}

function extractPreText(macro: string): string | null {
	const match = macro.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i);
	if (!match) {
		return null;
	}
	return decodeBasicHtmlEntities(stripTags(match[1]));
}

function getHtmlAttribute(html: string, attributeName: string): string | null {
	const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = html.match(new RegExp(`\\b${escapedName}\\s*=\\s*(['"])(.*?)\\1`, "i"));
	return match ? decodeBasicHtmlEntities(match[2]) : null;
}

function getAttachmentFilenameFromUrl(rawUrl: string): string | null {
	try {
		const url = rawUrl.startsWith("http")
			? new URL(rawUrl)
			: new URL(rawUrl, "https://placeholder.local");
		const match = url.pathname.match(/(?:\/wiki)?\/download\/attachments\/[^/]+\/([^/]+)/);
		return match ? decodeURIComponent(match[1]) : null;
	} catch {
		return null;
	}
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, "");
}

function decodeCdata(value: string): string {
	return value
		.replace(/^<!\[CDATA\[/, "")
		.replace(/\]\]>$/, "");
}

function decodeBasicHtmlEntities(value: string): string {
	return value
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}
