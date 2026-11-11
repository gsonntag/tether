// The account avatar: the person's Foliation profile picture (shared/protocol.ts User.picture),
// else Tether's own user icon. The picture is a public capability URL that browsers load directly;
// a new picture gets a new URL, so a reload (a new hello) shows a change.

/**
 * The picture to show, or undefined for the fallback icon: none set, not an http(s) URL, or this
 * very URL already failed to load (a different URL, i.e. a new picture, gets tried again).
 */
export function avatarSrc(picture: string | undefined, failed: string | undefined): string | undefined {
  if (!picture || picture === failed) return undefined;
  let url: URL;
  try {
    url = new URL(picture);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" || url.protocol === "http:" ? picture : undefined;
}
