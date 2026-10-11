// Normalises every known YouTube link shape to a canonical watch URL.
const HOST = /^([a-z0-9-]+\.)*(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;
const ID = /^[\w-]{11}$/;

export function resolveYouTube(input, depth = 0) {
  let s = String(input ?? "").trim().replace(/^<|>$/g, "");
  if (ID.test(s)) return new URL(`https://www.youtube.com/watch?v=${s}`);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error("Not a valid link"); }
  if (!HOST.test(u.hostname)) throw new Error("Only YouTube links are allowed");

  const seg = u.pathname.split("/").filter(Boolean);
  let id = null;
  if (/youtu\.be$/i.test(u.hostname)) id = seg[0];
  else if (seg[0] === "watch" && seg[1]) id = seg[1];                          // /watch/ID
  else if (["shorts", "live", "embed", "v", "e", "vi", "video"].includes(seg[0])) id = seg[1];
  else if (u.searchParams.get("v")) id = u.searchParams.get("v");               // /watch?v= , music., m.
  else if (depth < 2) {                                                         // redirect wrappers
    const inner = u.searchParams.get("u") ?? u.searchParams.get("q") ?? u.searchParams.get("url");
    if (inner) return resolveYouTube(new URL(inner, "https://www.youtube.com").href, depth + 1);
  }
  if (id && ID.test(id) && id !== "videoseries") return new URL(`https://www.youtube.com/watch?v=${id}`);
  if (u.searchParams.get("list") && (!id || id === "videoseries")) throw new Error("Playlist links are not supported here - use Import playlist");
  if (seg[0] === "clip" && seg[1]) return u;                                    // clips: let yt-dlp resolve them
  throw new Error("Unsupported YouTube link - paste a link to a single video");  // channels, searches, home page...
}

/** Playlist link (any YouTube URL carrying ?list=) -> canonical playlist URL. */
export function resolvePlaylist(input) {
  let s = String(input ?? "").trim().replace(/^<|>$/g, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error("Not a valid link"); }
  if (!HOST.test(u.hostname)) throw new Error("Only YouTube links are allowed");
  const list = u.searchParams.get("list");
  if (!list || !/^[\w-]{10,}$/.test(list)) throw new Error("No playlist found in this link");
  return new URL(`https://www.youtube.com/playlist?list=${list}`);
}
