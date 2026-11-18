// A row of the Files tab's flat lists (the filter's matches, the Changed view; SPEC §10 Files).

import { Icon } from "@astryxdesign/core/Icon";
import { DocumentIcon, FolderIcon, PhotoIcon } from "@heroicons/react/24/solid";
import { imageType } from "../../../shared/files";
import { MARKS, nameOf, parentOf } from "../files";
import { MarkBadge } from "./FileTree";

/**
 * A row of a flat list (the filter's matches, the Changed view): the path, its change mark if any.
 * Deleted ones don't open (still focusable, said disabled); a folder opens in the tree.
 */
export function PathRow({ path, mark, folder, onOpen }: { path: string; mark?: keyof typeof MARKS; folder?: boolean; onOpen?: (path: string) => void }) {
  const label = mark ? `${path}${folder ? " (folder)" : ""}, ${MARKS[mark].label}` : undefined;
  return (
    <li className={`t-files-row${mark ? ` changed ${mark}` : ""}${onOpen ? "" : " off"}`}>
      <button type="button" className="t-files-item" aria-disabled={onOpen ? undefined : true} aria-label={label} title={label} onClick={() => onOpen?.(path)}>
        <Icon icon={folder ? FolderIcon : imageType(path) ? PhotoIcon : DocumentIcon} size="sm" />
        <span className="t-files-name">
          {parentOf(path) && <span className="t-dpath-dir">{parentOf(path)}/</span>}
          {nameOf(path)}
        </span>
        {mark && <MarkBadge mark={mark} />}
      </button>
    </li>
  );
}
