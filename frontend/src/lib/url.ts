import {
  SESSION_QUERY_PARAM,
  VIEW_QUERY_PARAM,
  type AppView,
  type HistoryMode,
} from "./types";

export function getSessionKeyFromUrl(): string {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get(SESSION_QUERY_PARAM) ?? "";
}

export function syncSessionKeyToUrl(
  sessionKey: string,
  historyMode: Exclude<HistoryMode, "skip"> = "push"
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (sessionKey) {
    url.searchParams.set(SESSION_QUERY_PARAM, sessionKey);
  } else {
    url.searchParams.delete(SESSION_QUERY_PARAM);
  }
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  if (historyMode === "replace") {
    window.history.replaceState(null, "", nextUrl);
    return;
  }
  window.history.pushState(null, "", nextUrl);
}

export function getViewFromUrl(): AppView {
  if (typeof window === "undefined") return "sessions";
  const raw = new URL(window.location.href).searchParams.get(VIEW_QUERY_PARAM);
  return raw === "prompts" ? "prompts" : "sessions";
}

export function syncViewToUrl(
  view: AppView,
  historyMode: Exclude<HistoryMode, "skip"> = "replace"
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (view === "sessions") {
    url.searchParams.delete(VIEW_QUERY_PARAM);
  } else {
    url.searchParams.set(VIEW_QUERY_PARAM, view);
  }
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  if (historyMode === "replace") {
    window.history.replaceState(null, "", nextUrl);
    return;
  }
  window.history.pushState(null, "", nextUrl);
}
