// Single source of truth for the page's two colours: plain white, plain black.
//
// styles.css mirrors PAPER in :root as --paper. The two must stay identical:
// the local canvas paints PAPER rectangles over hovered glyphs to hide the DOM
// text beneath it, and any mismatch shows up as pale patches under the cursor.
export const PAPER = "#ffffff";
export const INK = "#000000";
// Component form, for interpolating ink toward paper as the page fades.
export const PAPER_RGB = [255, 255, 255];
export const INK_RGB = [0, 0, 0];

// The page spends its whole life in ink on paper and is allowed exactly one
// colour event: the instant the fragments arrive at the attractor. Cinnabar is
// the pigment of a carved seal, which is the note that moment is going for.
export const CINNABAR = "#c0392b";
export const CINNABAR_RGB = [192, 57, 43];
