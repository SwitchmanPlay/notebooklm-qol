/**
 * SINGLE source of truth for every DOM selector / label used by the extension.
 * All selectors were extracted from real NotebookLM captures (July 2026, English UI).
 * Nothing outside this file may touch raw selectors.
 */

export const SEL = {
  // ---- Source panel ----
  sourceRow: ".single-source-container",
  sourceRowTitle: ".source-title",
  sourceCheckboxInput: ".select-checkbox-container input.mdc-checkbox__native-control",
  selectAllSourcesInput: 'input[aria-label="Select all sources"]',
  // id encodes the source uuid: source-item-more-button-<uuid>
  sourceMoreButton: 'button[id^="source-item-more-button-"]',

  // ---- Studio panel ----
  artifactItem: "artifact-library-item",
  // id encodes the artifact uuid: artifact-labels-<uuid>
  artifactLabels: 'span[id^="artifact-labels-"]',
  artifactTitle: ".artifact-title",
  // Inline rename input that replaces the title after clicking "Rename"
  artifactTitleInput: "input.artifact-title-input",
  artifactDetails: ".artifact-details",
  artifactIcon: "mat-icon.artifact-icon",
  artifactMoreButton: 'button[aria-label="More"]',
  artifactActions: ".artifact-actions",
  // "Create" buttons grid in the Studio panel
  createButtonHost: "basic-create-artifact-button",
  createButton: '.create-artifact-button-container[role="button"]',

  // ---- Material overlays (menus / dialogs / snackbars) ----
  overlayContainer: ".cdk-overlay-container",
  menuPanel: ".mat-mdc-menu-panel",
  menuItem: 'button.mat-mdc-menu-item, [role="menuitem"]',
  menuItemText: ".mat-mdc-menu-item-text",
  dialogContainer: "mat-dialog-container",
  snackbarLabel: ".mat-mdc-snack-bar-label, .mdc-snackbar__label",

  // ---- Customize dialog (configurable-form-dialog) ----
  customizeButton: 'button[aria-label^="Customize "]',
  configDialog: "configurable-form-dialog",
  controlWrapper: ".control-wrapper",
  controlLabel: ".control-label",
  radioButton: "mat-radio-button",
  tileLabelContainer: ".tile-label-container",
  dialogActionsButton: "mat-dialog-actions button",
  dialogCloseButton: 'button[aria-label="Close dialog"]',

  // ---- "View prompt and sources" dialog (source-attribution-dialog) ----
  attributionDialog: "source-attribution-dialog",
  attributionSourceTitle: ".source-chip .source-title",
} as const

/** English menu-item labels (baseline; matching is case-insensitive + trimmed). */
export const LABELS = {
  artifactRename: ["rename"],
  artifactViewSources: ["view prompt and sources", "view prompt & sources", "view prompt"],
  artifactDownload: ["download"],
  artifactDelete: ["delete"],
  sourceRemove: ["remove source", "delete source", "delete"],
  // Confirm-dialog buttons we are allowed to click (never "cancel"/"close")
  confirm: ["delete", "remove", "confirm", "yes"],
  cancelish: ["cancel", "close", "no", "keep"],
  rateLimit: ["limit", "try again later", "quota"],
  generate: ["generate", "create"],
} as const

/** Map Studio artifact mat-icon ligature -> human-readable type label. */
export const ICON_TO_TYPE: Record<string, string> = {
  audio_magic_eraser: "Audio Overview",
  video_magic_eraser: "Video Overview",
  subscriptions: "Video Overview",
  animated_images: "Video Overview",
  cards_star: "Flashcards",
  quiz: "Quiz",
  tablet: "Slide Deck",
  network_intel_node: "Mind Map",
  flowchart: "Mind Map",
  handyman: "Reports",
  lab_profile: "Reports",
  table: "Data Table",
  emoji_objects: "Infographic",
  stacked_bar_chart: "Infographic",
}

export function sourceIdFromMoreButton(id: string | null | undefined): string | null {
  if (!id) return null
  const m = id.match(/^source-item-more-button-(.+)$/)
  return m ? m[1] : null
}

export function artifactIdFromLabels(id: string | null | undefined): string | null {
  if (!id) return null
  const m = id.match(/^artifact-labels-(.+)$/)
  return m ? m[1] : null
}
