// Themes: the choice is stored in localStorage ('pm-theme') and applied by a tiny script in index.html
// before the page draws, so there's no flash of the wrong colours.

export const THEMES = [
  { id: 'dark', label: 'Dark', paper: '#0b0d12', card: '#1c2130', ink: '#eef1f7', accent: '#8b9bff', bar: '#0b0d12' },
  { id: 'light', label: 'Light', paper: '#f4f5f8', card: '#ffffff', ink: '#151821', accent: '#4b5fe0', bar: '#f4f5f8' },
  { id: 'sketch', label: 'Sketchbook', paper: '#f5efe0', card: '#fffdf7', ink: '#2b2a27', accent: '#ffd84d', bar: '#f5efe0' },
  { id: 'auto', label: 'Match my phone', paper: 'linear-gradient(135deg, #f4f5f8 50%, #0b0d12 50%)', card: '#8f97ab', ink: '#151821', accent: '#8b9bff' },
];

export const currentTheme = () => document.documentElement.dataset.theme || 'dark';

/** The colour of the phone's status bar for a theme. */
function barColour(id) {
  if (id === 'auto') return matchMedia('(prefers-color-scheme: light)').matches ? '#f4f5f8' : '#0b0d12';
  return THEMES.find((t) => t.id === id)?.bar ?? '#0b0d12';
}

export function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', barColour(id));
  try {
    localStorage.setItem('pm-theme', id);
  } catch {
    // Not saved (private mode), but applied for now.
  }
}
