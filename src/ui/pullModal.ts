import { App, Modal, Setting, Notice } from "obsidian";
import type { PullEngine } from "../sync/pullEngine";

export class PullModal extends Modal {
	private pullEngine: PullEngine;
	private mode: "page" | "tree";
	private input = "";

	constructor(app: App, pullEngine: PullEngine, mode: "page" | "tree" = "page") {
		super(app);
		this.pullEngine = pullEngine;
		this.mode = mode;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("confluence-sync-pull-modal");

		contentEl.createEl("h3", {
			text: this.mode === "tree" ? "Pull page tree" : "Pull page",
		});

		new Setting(contentEl)
			.setName("Page URL or ID")
			.setDesc("Confluence page URL, page ID, or page title")
			.addText((text) => {
				text.setPlaceholder("https://confluence.example.com/pages/viewpage.action?pageId=12345");
				text.inputEl.addClass("confluence-sync-url-input");
				text.onChange((value) => {
					this.input = value;
				});
				// Submit on Enter
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void this.executePull();
					}
				});
			});

		new Setting(contentEl)
			.setName("Mode")
			.setDesc(
				this.mode === "tree"
					? "Pull this page and all child pages recursively"
					: "Pull only this single page",
			)
			.addDropdown((drop) => {
				drop.addOption("page", "Single page");
				drop.addOption("tree", "Page tree (recursive)");
				drop.setValue(this.mode);
				drop.onChange((value) => {
					this.mode = value as "page" | "tree";
				});
			});

		new Setting(contentEl).addButton((btn) => {
			btn.setButtonText("Pull")
				.setCta()
				.onClick(() => { void this.executePull(); });
		});
	}

	private async executePull(): Promise<void> {
		if (!this.input.trim()) {
			new Notice("Please enter a page URL, ID, or title.");
			return;
		}

		this.close();

		try {
			new Notice("Resolving page...");
			const pageId = await this.pullEngine.resolvePageId(this.input.trim());

			if (this.mode === "tree") {
				new Notice("Pulling page tree...");
				const result = await this.pullEngine.pullPageTree(
					pageId,
					[],
					undefined,
					(msg) => new Notice(msg),
				);
				const summary = [
					`Pull complete.`,
					result.created > 0 ? `Created: ${result.created}` : null,
					result.updated > 0 ? `Updated: ${result.updated}` : null,
					result.skipped > 0 ? `Up to date: ${result.skipped}` : null,
					result.attachments > 0 ? `Attachments: ${result.attachments}` : null,
					result.errors.length > 0 ? `Errors: ${result.errors.length}` : null,
				]
					.filter(Boolean)
					.join(", ");
				new Notice(summary);

				if (result.errors.length > 0) {
					console.error("Confluence pull errors:", result.errors);
				}
			} else {
				const result = await this.pullEngine.pullPage(pageId);
				switch (result.status) {
					case "created":
						new Notice("Page pulled successfully!");
						break;
					case "updated":
						new Notice("Page updated.");
						break;
					case "skipped":
						new Notice("Page is already up to date.");
						break;
				}
				if (result.attachments.folder) {
					new Notice(
						`Attachments: found ${result.attachments.found}, downloaded ${result.attachments.downloaded} in ${result.attachments.folder}`,
						10000,
					);
				}
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Pull failed: ${msg}`);
			console.error("Confluence pull error:", e);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
