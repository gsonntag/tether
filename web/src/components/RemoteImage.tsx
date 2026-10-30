// Images in Claude's markdown are not fetched by themselves: a remote image would tell its server
// who's reading and when. A link loads it on request. (Inline data: images never get here: the
// markdown sanitizer drops data: URLs, which also keeps out data:text/html and SVG.)

import { useRowState } from "./sessionContext";

export function RemoteImage({ src, alt }: { src: string; alt: string }) {
  // allowed once stays allowed when the row is unmounted and mounted again
  const [show, setShow] = useRowState(`image:${src}`, false);
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
