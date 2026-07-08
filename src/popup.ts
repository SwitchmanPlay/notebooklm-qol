import { loadSettings, saveSettings, Settings } from "./lib/settings.ts"
import { templatePreview } from "./lib/template.ts"

const $ = (id: string) => document.getElementById(id) as HTMLInputElement

async function main(): Promise<void> {
  const settings = await loadSettings()
  $("template").value = settings.template
  $("f-studioBulk").checked = settings.features.studioBulk
  $("f-batchGenerate").checked = settings.features.batchGenerate
  $("f-sourceBulk").checked = settings.features.sourceBulk
  renderPreview()

  let t: number | undefined
  const save = () => {
    clearTimeout(t)
    t = setTimeout(async () => {
      const s: Settings = {
        template: $("template").value.trim() || settings.template,
        features: {
          studioBulk: $("f-studioBulk").checked,
          batchGenerate: $("f-batchGenerate").checked,
          sourceBulk: $("f-sourceBulk").checked,
        },
      }
      await saveSettings(s)
      const saved = document.getElementById("saved")!
      saved.textContent = "Saved \u2713"
      setTimeout(() => (saved.textContent = ""), 1500)
    }, 350) as unknown as number
  }

  $("template").addEventListener("input", () => {
    renderPreview()
    save()
  })
  for (const id of ["f-studioBulk", "f-batchGenerate", "f-sourceBulk"]) {
    $(id).addEventListener("change", save)
  }
}

function renderPreview(): void {
  const el = document.getElementById("preview")!
  try {
    el.textContent = `Preview: ${templatePreview($("template").value || "")}`
  } catch {
    el.textContent = ""
  }
}

main()
