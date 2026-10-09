/**
 * Home's one open panel (INLINE_UPLOAD_AND_SOURCES_UPDATE, "Shared open
 * state"): a category card's setup, the upload card, or a saved source's row.
 * Opening any panel closes the one that is open; leaving Home drops it (it is
 * Home's state, so unmounting Home resets it). Pure: no React.
 */
export type PanelId = `cat:${string}` | "upload" | `src:${string}`;
export type OpenPanel = PanelId | null;

export const catPanel = (slug: string): PanelId => `cat:${slug}`;
export const srcPanel = (sourceId: string): PanelId => `src:${sourceId}`;
export const UPLOAD_PANEL: PanelId = "upload";

/** Open `panel`; whatever was open closes. */
export const openPanel = (_current: OpenPanel, panel: PanelId): OpenPanel => panel;

/** Close `panel` if it is the open one; anything else stays as it is (a late close never closes a newer panel). */
export const closePanel = (current: OpenPanel, panel: PanelId): OpenPanel =>
  current === panel ? null : current;
