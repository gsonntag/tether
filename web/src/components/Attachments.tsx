// Attachment chips: the composer's files (uploading, ready, refused) and the files a sent or
// waiting message carries (thumbnails that open full size, file chips that download).

import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Lightbox } from "@astryxdesign/core/Lightbox";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { DocumentIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { download, draftLabel, removeDraft, useAttachmentUrl, type Draft } from "../attachments";
import { formatSize, NATIVE_IMAGE_TYPES, type Attachment } from "../shared/attachments";
import { toast } from "../store";

/** The composer's files, above the message box. */
export function DraftChips({ sessionId, drafts }: { sessionId: string; drafts: Draft[] }) {
  return (
    <HStack gap={1.5} wrap="wrap" vAlign="center">
      {drafts.map((d) =>
        d.preview && !d.error ? (
          <Thumbnail
            key={d.key}
            src={d.preview}
            alt={d.name}
            label={draftLabel(d)}
            isLoading={!d.attachment}
            showRemoveOn="always"
            onRemove={() => removeDraft(sessionId, d.key)}
          />
        ) : (
          <Tooltip key={d.key} content={d.error} isEnabled={!!d.error} hasHoverIndication={false}>
            <Token
              size="md"
              color={d.error ? "red" : "default"}
              icon={<Icon icon={d.error ? "error" : DocumentIcon} size="sm" />}
              label={draftLabel(d)}
              onRemove={() => removeDraft(sessionId, d.key)}
            />
          </Tooltip>
        ),
      )}
    </HStack>
  );
}

/** One stored image: loads from the runner when shown; a tap opens it full size. */
function StoredImage({ a }: { a: Attachment }) {
  const { url, error } = useAttachmentUrl(a.path, a.mimeType);
  const [open, setOpen] = useState(false);
  if (error) return <FileChip a={a} />;
  return (
    <>
      <Thumbnail src={url} alt={a.name} label={`${a.name} · ${formatSize(a.size)}`} isLoading={!url} onClick={() => url && setOpen(true)} />
      {url && <Lightbox isOpen={open} onOpenChange={setOpen} hasZoom media={{ src: url, alt: a.name, caption: a.name }} />}
    </>
  );
}

function FileChip({ a }: { a: Attachment }) {
  return (
    <Token
      size="md"
      icon={<Icon icon={DocumentIcon} size="sm" />}
      label={`${a.name} · ${formatSize(a.size)}`}
      description={`Download ${a.name}`}
      onClick={() => download(a).catch((e) => toast("error", `Couldn't download ${a.name}: ${e?.message ?? e}`))}
    />
  );
}

/** The files a message carries. Images the browser can show become thumbnails. */
export function AttachmentChips({ files }: { files: Attachment[] }) {
  if (!files.length) return null;
  return (
    <HStack gap={1.5} wrap="wrap" vAlign="center">
      {files.map((a) => (NATIVE_IMAGE_TYPES.has(a.mimeType) ? <StoredImage key={a.path} a={a} /> : <FileChip key={a.path} a={a} />))}
    </HStack>
  );
}
