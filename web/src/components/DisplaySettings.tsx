import {
  STREAMING_ANIMATION_THRESHOLD,
  useStreamingAnimationSetting,
  type StreamingAnimationSetting,
} from "../streamingSettings";

export function DisplaySettings() {
  const [setting, setSetting] = useStreamingAnimationSetting();

  const options: { value: StreamingAnimationSetting; title: string; description: string }[] = [
    {
      value: "auto",
      title: "Auto (recommended)",
      description: `Reveals words smoothly on normal sessions; switches to instant text and CSS spinner on huge sessions (over ${STREAMING_ANIMATION_THRESHOLD.toLocaleString()} messages loaded) to avoid browser stalls.`,
    },
    {
      value: "on",
      title: "On",
      description: "Word-by-word reveal, fade-in animation, and SVG spinner on all sessions.",
    },
    {
      value: "off",
      title: "Off",
      description: "Text appears instantly as chunks arrive with CSS spinner and no fade animation.",
    },
  ];

  return (
    <div className="t-display-settings" aria-label="Display">
      <p className="t-settings-note">
        Streaming animations look smooth but can cause browser freezes and memory spikes on long transcripts. Stored per device.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }} role="radiogroup" aria-label="Streaming animation">
        {options.map((opt) => (
          <label key={opt.value} className="t-notify" style={{ cursor: "pointer", alignItems: "flex-start" }}>
            <input
              type="radio"
              name="streamingAnimation"
              value={opt.value}
              checked={setting === opt.value}
              onChange={() => setSetting(opt.value)}
              style={{ marginTop: "4px" }}
            />
            <div className="t-notify-text">
              <span className="t-notify-title">{opt.title}</span>
              <span className="t-inline-status">{opt.description}</span>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
