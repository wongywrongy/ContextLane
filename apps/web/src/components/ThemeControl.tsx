import { useState } from "react";
export function ThemeControl() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  return <div className="sec-r"><label htmlFor="theme">Theme</label><select id="theme" className="sel" value={theme} onChange={e => { const value = e.target.value; document.documentElement.dataset.theme = value; setTheme(value); try { localStorage.setItem("cl-theme", value); } catch { /* This window still uses the chosen theme. */ } }}><option value="dark">Dark</option><option value="light">Light</option></select><span className="muted">Saved in this browser</span></div>;
}
