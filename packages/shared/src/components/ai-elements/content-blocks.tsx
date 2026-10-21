import type { ContentBlock } from "../../acp/types";
import { cn } from "../../lib/utils";
import { ExternalLink, FileText } from "lucide-react";
import { MessageAttachment, MessageAttachments, MessageResponse } from "./message";

function toDataUrl(mimeType: string | null | undefined, data: string): string {
  return `data:${mimeType || "application/octet-stream"};base64,${data}`;
}

function ResourceChip({
  href,
  label,
  description,
}: {
  href: string;
  label: string;
  description?: string | null;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={description ?? undefined}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs text-foreground hover:bg-muted"
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

/**
 * Renders ACP `ContentBlock`s.
 *
 * Reference: Zed's `content::from_v1` / `ContentBlock` rendering — text,
 * images, audio, resource links, and embedded resources are all supported.
 */
export function ContentBlockList({
  blocks,
  className,
}: {
  blocks: ContentBlock[];
  className?: string;
}) {
  if (blocks.length === 0) return null;

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case "text":
            return block.text ? (
              <MessageResponse key={index}>{block.text}</MessageResponse>
            ) : null;

          case "image":
            return (
              <MessageAttachments key={index}>
                <MessageAttachment
                  data={{
                    type: "file",
                    mediaType: block.mimeType,
                    url: toDataUrl(block.mimeType, block.data),
                    filename: block.uri ?? undefined,
                  }}
                />
              </MessageAttachments>
            );

          case "audio":
            return (
              <audio
                key={index}
                controls
                src={toDataUrl(block.mimeType, block.data)}
                className="max-w-sm"
              />
            );

          case "resource_link":
            return (
              <ResourceChip
                key={index}
                href={block.uri}
                label={block.title || block.name}
                description={block.description}
              />
            );

          case "resource": {
            const resource = block.resource;
            if ("text" in resource) {
              return (
                <div key={index} className="min-w-0">
                  <ResourceChip href={resource.uri} label={resource.uri} />
                  <div className="mt-1 text-xs">
                    <MessageResponse>{resource.text}</MessageResponse>
                  </div>
                </div>
              );
            }
            return <ResourceChip key={index} href={resource.uri} label={resource.uri} />;
          }

          default:
            // Unknown content from a newer schema: surface it instead of dropping.
            return (
              <pre
                key={index}
                className="overflow-x-auto rounded-md bg-muted/50 p-2 text-xs"
              >
                {JSON.stringify(block, null, 2)}
              </pre>
            );
        }
      })}
    </div>
  );
}
