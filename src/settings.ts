import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type ConfluenceSyncPlugin from "./main";

export class ConfluenceSyncSettingTab extends PluginSettingTab {
	plugin: ConfluenceSyncPlugin;

	constructor(app: App, plugin: ConfluenceSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Confluence deployment")
			.setDesc("Choose Data Center/Server or Cloud")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("data-center", "Data Center / Server")
					.addOption("cloud", "Cloud")
					.setValue(this.plugin.settings.deploymentType)
					.onChange((value) => {
						this.plugin.settings.deploymentType = value as "data-center" | "cloud";
						void this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Confluence base URL")
			.setDesc("Base URL of your Confluence instance (e.g., https://confluence.example.com or https://example.atlassian.net)")
			.addText((text) =>
				text
					.setPlaceholder(
						this.plugin.settings.deploymentType === "cloud"
							? "https://example.atlassian.net"
							: "https://confluence.example.com",
					)
					.setValue(this.plugin.settings.baseUrl)
					.onChange((value) => {
						this.plugin.settings.baseUrl = value.replace(/\/+$/, "");
						void this.plugin.saveSettings();
					}),
			);

		if (this.plugin.settings.deploymentType === "cloud") {
			new Setting(containerEl)
				.setName("Atlassian account email")
				.setDesc("Email address for Confluence Cloud API token authentication")
				.addText((text) =>
					text
						.setPlaceholder("you@example.com")
						.setValue(this.plugin.settings.cloudEmail)
						.onChange((value) => {
							this.plugin.settings.cloudEmail = value.trim();
							void this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName(this.plugin.settings.deploymentType === "cloud" ? "API token" : "Personal access token")
			.setDesc(
				this.plugin.settings.deploymentType === "cloud"
					? "Confluence Cloud API token from your Atlassian account"
					: "Confluence Data Center / Server personal access token for authentication",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("Enter your token")
					.setValue(this.plugin.settings.pat)
					.onChange((value) => {
						this.plugin.settings.pat = value;
						void this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify connection to server")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(() => {
					btn.setDisabled(true);
					btn.setButtonText("Testing...");
					void this.plugin.client.testConnection()
						.then((result) => {
							const total = result.size;
							new Notice(`Connected! Found ${total} space(s).`);
						})
						.catch((e: unknown) => {
							const msg = e instanceof Error ? e.message : String(e);
							new Notice(`Connection failed: ${msg}`);
						})
						.finally(() => {
							btn.setDisabled(false);
							btn.setButtonText("Test");
						});
				}),
			);

		new Setting(containerEl)
			.setName("Skip SSL verification")
			.setDesc("Disable TLS certificate verification (for self-signed certificates). Requires restart.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.skipSsl).onChange((value) => {
					this.plugin.settings.skipSsl = value;
					void this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Default space key")
			.setDesc("Space key used when searching by title")
			.addText((text) =>
				text
					.setPlaceholder("MYSPACE")
					.setValue(this.plugin.settings.defaultSpaceKey)
					.onChange((value) => {
						this.plugin.settings.defaultSpaceKey = value;
						void this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sync folder path")
			.setDesc("Folder in vault where synced pages will be stored")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.syncFolder)
					.onChange((value) => {
						this.plugin.settings.syncFolder = value.replace(/\/+$/, "");
						void this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Pull attachments")
			.setDesc("Download page attachments when pulling pages")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.pullAttachments).onChange((value) => {
					this.plugin.settings.pullAttachments = value;
					void this.plugin.saveSettings();
				}),
			);
	}
}
