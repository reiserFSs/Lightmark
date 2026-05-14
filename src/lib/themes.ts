import type { ThemePreset } from "./types";

export const THEMES: ThemePreset[] = [
  {
    id: "classic-dark",
    name: "Classic Dark",
    backgroundOverlay: "rgba(9, 10, 9, 0.42)",
    panelRule: "rgba(255, 255, 255, 0.15)",
    text: "#f7f4ed",
    mutedText: "rgba(247, 244, 237, 0.82)",
    accent: "#f7f4ed",
    shadow: "rgba(0, 0, 0, 0.36)",
    fontFamily: "Avenir Next, Helvetica Neue, sans-serif",
  },
  {
    id: "film-warm",
    name: "Film Warm",
    backgroundOverlay: "rgba(28, 19, 13, 0.35)",
    panelRule: "rgba(255, 226, 187, 0.2)",
    text: "#fff2dd",
    mutedText: "rgba(255, 242, 221, 0.8)",
    accent: "#ffd99a",
    shadow: "rgba(23, 10, 2, 0.35)",
    fontFamily: "Georgia, Charter, serif",
  },
  {
    id: "clean-light",
    name: "Clean Light",
    backgroundOverlay: "rgba(247, 248, 241, 0.32)",
    panelRule: "rgba(24, 30, 33, 0.18)",
    text: "#202425",
    mutedText: "rgba(32, 36, 37, 0.72)",
    accent: "#202425",
    shadow: "rgba(255, 255, 255, 0.22)",
    fontFamily: "Avenir Next, Helvetica Neue, sans-serif",
  },
];

export const DEFAULT_THEME = THEMES[0];
