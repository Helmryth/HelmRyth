export type ScreenPreviewFailurePhase = "cancelled" | "unavailable" | "error";

export interface ScreenPreviewStream {
  getTracks: () => Array<Pick<MediaStreamTrack, "stop">>;
  getVideoTracks: () => Array<Pick<MediaStreamTrack, "stop">>;
}

export type ScreenPreviewStartResult<Stream extends ScreenPreviewStream = MediaStream> =
  | { ok: true; stream: Stream }
  | { ok: false; phase: ScreenPreviewFailurePhase; message: string };

type ScreenPreviewRequest<Stream extends ScreenPreviewStream> = {
  beginIntent: () => boolean;
  getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<Stream>;
};

export function stopScreenPreview(stream: Pick<ScreenPreviewStream, "getTracks"> | null) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function normalizeScreenPreviewFailure(cause: unknown): Error | null {
  return cause instanceof Error ? cause : null;
}

export function screenPreviewFailure(error: Error | null): Exclude<ScreenPreviewStartResult, { ok: true }> {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError") {
    return {
      ok: false,
      phase: "cancelled",
      message: "Screen selection was cancelled. Nothing is being shared.",
    };
  }
  if (
    name === "NotFoundError" ||
    name === "NotReadableError" ||
    name === "NotSupportedError" ||
    name === "SecurityError"
  ) {
    return {
      ok: false,
      phase: "unavailable",
      message: "Screen preview isn't available right now.",
    };
  }
  return { ok: false, phase: "error", message: "Couldn't start screen preview." };
}

export async function requestScreenPreview<Stream extends ScreenPreviewStream>({
  beginIntent,
  getDisplayMedia,
}: ScreenPreviewRequest<Stream>): Promise<ScreenPreviewStartResult<Stream>> {
  try {
    // Keep these synchronous and adjacent so Chromium sees the media request
    // in the same user gesture that armed the one-shot main-process intent.
    if (!beginIntent()) {
      return {
        ok: false,
        phase: "unavailable",
        message: "Screen preview isn't available from this window.",
      };
    }
    const stream = await getDisplayMedia({ video: true, audio: false });
    if (stream.getVideoTracks().length === 0) {
      stopScreenPreview(stream);
      return {
        ok: false,
        phase: "unavailable",
        message: "The selected source did not provide a video stream.",
      };
    }
    return { ok: true, stream };
  } catch (error) {
    return screenPreviewFailure(normalizeScreenPreviewFailure(error));
  }
}
