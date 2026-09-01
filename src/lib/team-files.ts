import { api } from "@/state/store";
import { z } from "zod";

const exportedPlaybookSchema = z.object({
  name: z.string(),
  members: z.number().int().nonnegative(),
  markdown: z.string(),
});

type ExportedPlaybook = z.infer<typeof exportedPlaybookSchema>;

export interface PlaybookDownload {
  name: string;
  members: number;
}

function downloadPlaybook(playbook: ExportedPlaybook): PlaybookDownload {
  const slug =
    playbook.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "helmryth-crew";
  const blob = new Blob([playbook.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name: playbook.name, members: playbook.members };
}

/** Export every active sidebar bot as one portable Chief-of-Staff Markdown. */
export async function downloadAllBots(): Promise<PlaybookDownload> {
  const playbook = exportedPlaybookSchema.parse(
    await api("/api/teams/export", {
      method: "POST",
      body: JSON.stringify({ format: "package" }),
    }),
  );
  return downloadPlaybook(playbook);
}
