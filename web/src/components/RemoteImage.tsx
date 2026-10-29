// Images in Claude's markdown are not fetched by themselves: a remote image would tell its server
// who's reading and when. A link loads it on request. (Inline data: images never get here: the
// markdown sanitizer drops data: URLs, which also keeps out data:text/html and SVG.)

import { useState } from "react";

export function RemoteImage({ src, alt }: { src: string; alt: string }) {
  const [show, setShow] = useState(false);
  if (show) return <img src={src} alt={alt} className="t-img" />;
  let host = src;
  try {
    host = new URL(src).host;
  } catch {}
  return (
    <button type="button" className="t-link" onClick={() => setShow(true)} title={src}>
      Load image{alt ? ` “${alt}”` : ""} from {host}
    </button>
  );
}
