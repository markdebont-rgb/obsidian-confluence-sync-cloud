# Obsidian Confluence Reader

Read-only sync of **Confluence Cloud** or **Confluence Data Center / Server** pages into your Obsidian vault as Markdown.

## Features

- **Pull single page** — by URL, page ID, or title
- **Pull page tree** — recursively pull a page and all its children
- **Re-pull** — update previously synced pages when Confluence content changes
- **Confluence → Markdown** conversion with support for:
  - Code blocks (with language)
  - Info/Warning/Note/Tip macros → Obsidian callouts (`> [!info]`)
  - Page links → `[[wikilinks]]`
  - Images and attachments
  - Expand macros → `<details>` blocks
  - Table of Contents → `[TOC]`
  - Status badges, panels, emoticons
- **Version tracking** — skips pages that haven't changed
- **Frontmatter mapping** — each synced file has `confluence-*` YAML fields
- **Attachment download** (optional)

## Setup

1. Install the plugin (BRAT or manual)
2. Go to **Settings → Confluence Reader**
3. Choose your Confluence deployment type:
   - **Cloud** for `https://example.atlassian.net`
   - **Data Center / Server** for self-hosted Confluence
4. Enter your Confluence Base URL:
   - Cloud: `https://example.atlassian.net` or `https://example.atlassian.net/wiki`
   - Data Center / Server: `https://confluence.example.com`
5. Configure authentication:
   - Cloud: enter your Atlassian account email and API token
   - Data Center / Server: enter your Personal Access Token (PAT)
6. Click **Test Connection**
7. Set the sync folder (default: `confluence-pages`)

### SSL

For self-signed certificates, enable **Skip SSL verification** in settings (requires Obsidian restart).

## Commands

| Command | Description |
|---------|-------------|
| `Confluence: Pull page` | Pull a single page by URL/ID/title |
| `Confluence: Pull page tree` | Recursively pull page and all children |
| `Confluence: Re-pull current file` | Update the current file from Confluence |
| `Confluence: Re-pull all synced files` | Update all previously synced files |
| `Confluence: Browse spaces` | List available Confluence spaces |

A ribbon icon (cloud download) opens the Pull page modal.

## Frontmatter

Each synced file gets YAML frontmatter:

```yaml
---
confluence-id: "12345678"
confluence-space: "MYSPACE"
confluence-version: 5
confluence-title: "Page Title"
confluence-url: "https://confluence.example.com/pages/viewpage.action?pageId=12345678"
confluence-last-pull: "2026-03-02T10:00:00.000Z"
confluence-author: "John Doe"
---
```

## File Structure

Pages with children create a folder hierarchy:

```
sync-folder/
  Root Page/
    Root Page.md
    Child A.md
    Child B/
      Child B.md
      Grandchild.md
```

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # production build
npm run typecheck # TypeScript check
```

## Compatibility

- Confluence **Cloud** and **Server / Data Center** (REST API v1)
- Cloud authentication: Atlassian account email + API token (Basic auth)
- Data Center / Server authentication: Personal Access Token (Bearer)
- Obsidian **1.5.0+**, desktop only

## License

[MIT](LICENSE)
