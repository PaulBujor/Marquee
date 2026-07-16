import React, { useState, useEffect } from "react";
// ---------------------------------------------------------------------------
// Reference implementation for the watchlist app's UI/UX — not shippable code
// (React + inline styles, one file, throwaway mock data). The written spec
// (watchlist-spec.md) points into this file by `data-spec-ref` values on key
// elements, e.g. "see `data-spec-ref="continue-watching-quickmark"` in
// watchlist-ui-concept.jsx" — these attributes exist purely to make that
// cross-referencing possible and should NOT be carried into the real app
// unless a real need for them shows up later (e.g. as e2e test hooks).
// ---------------------------------------------------------------------------
import {
  Search,
  CalendarDays,
  Settings,
  Heart,
  Check,
  ChevronLeft,
  ChevronDown,
  Sun,
  Moon,
  Film,
  Tv,
  SlidersHorizontal,
  FileQuestion,
  Star,
  Clock,
  Play,
  Link2,
  LogOut,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Mock data. Titles are invented (no real film/show names or artwork used —
// "posters" are generated gradients standing in for real images). One item
// ("Midnight Cassette Club") represents a custom/unlinked entry per the spec:
// no artwork, fuzzy year precision, muted placeholder tile.
// ---------------------------------------------------------------------------

const GENRES = {
  scifi: ["#2B4C6F", "#1B2A41"],
  thriller: ["#5B2A5E", "#2A1830"],
  drama: ["#8C5A2B", "#3A2414"],
  mystery: ["#2E4038", "#16211C"],
  arthouse: ["#3E6E63", "#1D3730"],
};

const GENRE_LABELS = {
  scifi: "Sci-Fi",
  thriller: "Thriller",
  drama: "Drama",
  mystery: "Mystery",
  arthouse: "Arthouse",
};

const RAW_SHOWS = [
  {
    id: 1,
    title: "Nightfall Station",
    type: "show",
    genre: "scifi",
    year: 2024,
    status: "watching",
    favorite: true,
    seasons: [
      {
        number: 1,
        episodes: [
          { number: 1, title: "Arrival", airDate: "Mar 2", watched: true },
          { number: 2, title: "Static", airDate: "Mar 9", watched: true },
          { number: 3, title: "Low Orbit", airDate: "Mar 16", watched: true },
          { number: 4, title: "Signal Loss", airDate: "Mar 23", watched: false },
          { number: 5, title: "The Long Dark", airDate: "Mar 30", watched: false },
        ],
      },
    ],
  },
  {
    id: 2,
    title: "Salt & Static",
    type: "show",
    genre: "thriller",
    year: 2023,
    status: "watching",
    favorite: false,
    seasons: [
      {
        number: 1,
        episodes: [
          { number: 1, title: "Frequency", airDate: "Jan 5", watched: true },
          { number: 2, title: "Interference", airDate: "Jan 12", watched: true },
          { number: 3, title: "Dead Air", airDate: "Jan 19", watched: false },
          { number: 4, title: "Echo Chamber", airDate: "Jan 26", watched: false },
        ],
      },
    ],
  },
  {
    id: 3,
    title: "Ember County",
    type: "show",
    genre: "drama",
    year: 2022,
    status: "watching",
    favorite: true,
    seasons: [
      {
        number: 2,
        episodes: [
          { number: 1, title: "Harvest", airDate: "Feb 1", watched: true },
          { number: 2, title: "Kindling", airDate: "Feb 8", watched: true },
          { number: 3, title: "Controlled Burn", airDate: "Feb 15", watched: true },
          { number: 4, title: "Ash", airDate: "Feb 22", watched: false },
        ],
      },
    ],
  },
  {
    id: 4,
    title: "The Long Orbit",
    type: "movie",
    genre: "scifi",
    year: 2019,
    status: "want_to_watch",
    favorite: false,
    watched: false,
  },
  {
    id: 5,
    title: "Paper Moths",
    type: "movie",
    genre: "arthouse",
    year: 2016,
    status: "want_to_watch",
    favorite: true,
    watched: false,
  },
  {
    id: 6,
    title: "Low Tide Radio",
    type: "show",
    genre: "mystery",
    year: 2024,
    status: "want_to_watch",
    favorite: false,
    seasons: [
      {
        number: 1,
        episodes: [
          { number: 1, title: "Driftwood", airDate: "Apr 4", watched: false },
          { number: 2, title: "Undertow", airDate: "Apr 11", watched: false },
        ],
      },
    ],
  },
  {
    id: 10,
    title: "Midnight Cassette Club",
    type: "movie",
    genre: "drama",
    yearLabel: "1980s",
    source: "custom",
    status: "want_to_watch",
    favorite: false,
    watched: false,
  },
  {
    id: 7,
    title: "The Glass Foundry",
    type: "movie",
    genre: "drama",
    year: 2011,
    status: "completed",
    favorite: true,
    watched: true,
  },
  {
    id: 8,
    title: "Concrete Bloom",
    type: "show",
    genre: "arthouse",
    year: 2009,
    status: "completed",
    favorite: false,
    seasons: [
      {
        number: 1,
        episodes: [
          { number: 1, title: "Rebar", airDate: "Nov 3", watched: true },
          { number: 2, title: "Foundation", airDate: "Nov 10", watched: true },
        ],
      },
    ],
  },
  {
    id: 9,
    title: "Signal Lost",
    type: "movie",
    genre: "mystery",
    year: 2020,
    status: "completed",
    favorite: false,
    watched: true,
  },
];

// Faked "TMDB enrichment" layer — invented overview text, rating, runtime,
// and cast, applied on top of the raw list. Custom/unlinked entries are
// deliberately skipped here: they have no external metadata until matched.
const OVERVIEWS = {
  1: "A skeleton crew aboard a dying research station picks up a signal that shouldn't exist — and starts losing time to answer it.",
  2: "A shortwave radio host stumbles onto a decades-old conspiracy buried under a coastal town's static.",
  3: "Three siblings inherit their father's failing orchard, and the debts he never mentioned.",
  4: "The last crewed mission to the outer belt loses contact eleven days from home.",
  5: "A retired origami teacher revisits the fishing village she left fifty years ago.",
  6: "A missing persons case reopens when the tide uncovers something it shouldn't.",
  7: "A glassblower losing his eyesight trains the apprentice meant to replace him.",
  8: "A demolition crew keeps finding gardens no one planted inside condemned buildings.",
  9: "A search-and-rescue pilot hears a mayday that was broadcast three years ago.",
  10: "A late-night DJ inherits a defunct record shop and the mixtapes nobody came back to collect.",
};

// Fake candidate matches for the manual-link demo on the custom entry
const LINK_CANDIDATES = [
  { label: "Midnight Cassette Club", year: 1984 },
  { label: "Cassette Club", year: 1987 },
];
const NAME_POOL = [
  "Mara Solberg", "Idris Bakare", "Tomasz Wren", "Yuki Amano",
  "Devon Castellano", "Priya Ashwood", "Lior Ben-David", "Greta Voss",
];
const ROLE_POOL = ["Lead", "Detective", "The Warden", "Narrator", "Supporting", "Guest Star", "Recurring", "Ensemble"];

function enrich(item, idx) {
  if (item.source === "custom") return item;
  const cast = Array.from({ length: 4 }, (_, i) => ({
    name: NAME_POOL[(idx + i) % NAME_POOL.length],
    role: ROLE_POOL[(idx + i * 2) % ROLE_POOL.length],
  }));
  return {
    ...item,
    overview: OVERVIEWS[item.id],
    rating: (6.6 + ((idx * 37) % 18) / 10).toFixed(1),
    runtime: item.type === "movie" ? 92 + ((idx * 13) % 40) : 34 + ((idx * 7) % 18),
    cast,
  };
}

const SHOWS = RAW_SHOWS.map(enrich);

// Mock "TMDB" catalog for the Search screen when network is up — a wider pool
// than the user's own tracked items, so search can surface something new.
// Two entries here aren't in RAW_SHOWS at all, to demonstrate discovering and
// adding something you don't already track.
const CATALOG_EXTRAS = [
  {
    id: 101,
    title: "Harbor Static",
    type: "show",
    genre: "mystery",
    year: 2023,
    status: "want_to_watch",
    favorite: false,
    seasons: [
      {
        number: 1,
        episodes: [
          { number: 1, title: "Frequency Drift", airDate: "May 2", watched: false },
          { number: 2, title: "Dead Channel", airDate: "May 9", watched: false },
        ],
      },
    ],
  },
  {
    id: 102,
    title: "The Quiet Version",
    type: "movie",
    genre: "drama",
    year: 2021,
    status: "want_to_watch",
    favorite: false,
    watched: false,
  },
];
OVERVIEWS[101] = "A harbor pilot's radio starts picking up boats that were decommissioned years ago.";
OVERVIEWS[102] = "A ghostwriter is hired to finish a memoir the author never wanted published.";
const TMDB_CATALOG = [...SHOWS.filter((s) => s.source !== "custom"), ...CATALOG_EXTRAS.map((e, i) => enrich(e, i + 20))];

// Progress is derived live from episode watched-state, not stored — so marking
// an episode watched updates the ring immediately with no separate field to sync.
function computeProgress(item) {
  if (item.type !== "show" || !item.seasons) return undefined;
  const season = item.seasons[item.seasons.length - 1];
  const total = season.episodes.length;
  if (total === 0) return undefined;
  const watched = season.episodes.filter((e) => e.watched).length;
  return watched / total;
}

function bucketFor(item) {
  if (item.yearLabel) return item.yearLabel;
  const y = item.year;
  if (y >= 2020) return "2020s";
  if (y >= 2010) return "2010s";
  if (y >= 2000) return "2000s";
  return "Older";
}

const TABS = [
  { key: "want_to_watch", label: "Want to Watch" },
  { key: "watching", label: "Watching" },
  { key: "completed", label: "Completed" },
  { key: "favorites", label: "Favorites" },
];

// ---------------------------------------------------------------------------

function useSystemDark() {
  const [systemDark, setSystemDark] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)").matches : true
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return systemDark;
}

function useWindowWidth() {
  const [width, setWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 390);
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return width;
}

function useTheme(dark) {
  if (dark) {
    return {
      bg: "#131316",
      surface: "#1D1D21",
      surfaceAlt: "#242428",
      text: "#F1EFEA",
      textMuted: "#9C9A94",
      border: "#2A2A2F",
      scrim: "linear-gradient(to top, rgba(19,19,22,0.95), rgba(19,19,22,0))",
    };
  }
  return {
    bg: "#F7F6F2",
    surface: "#FFFFFF",
    surfaceAlt: "#F1EFEA",
    text: "#201F1D",
    textMuted: "#77746D",
    border: "#E7E4DD",
    scrim: "linear-gradient(to top, rgba(255,255,255,0.96), rgba(255,255,255,0))",
  };
}

const ACCENT = "#E7A33D";

function ProgressRing({ progress, size = 34, stroke = 3, theme }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - progress);
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={theme.border} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={ACCENT}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.4s ease" }}
      />
    </svg>
  );
}

function XPlaceholder({ width, height, radius = 10, theme }) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        position: "relative",
        overflow: "hidden",
        background: theme.surfaceAlt,
        border: `1px solid ${theme.border}`,
        flexShrink: 0,
      }}
    >
      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0 }}>
        <line x1="0" y1="0" x2="100" y2="100" stroke={theme.border} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <line x1="100" y1="0" x2="0" y2="100" stroke={theme.border} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function PosterTile({ item, theme, children }) {
  const isCustom = item.source === "custom";
  return (
    <div
      style={{
        width: "100%",
        aspectRatio: "2 / 3",
        borderRadius: 14,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "flex-end",
        background: isCustom
          ? theme.surfaceAlt
          : `linear-gradient(155deg, ${GENRES[item.genre][0]}, ${GENRES[item.genre][1]})`,
        border: isCustom ? `1.5px dashed ${theme.border}` : "none",
      }}
    >
      {isCustom && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <FileQuestion size={26} color={theme.textMuted} />
        </div>
      )}
      <div style={{ position: "absolute", top: 8, left: 8, opacity: isCustom ? 0.5 : 0.55 }}>
        {item.type === "movie" ? (
          <Film size={14} color={isCustom ? theme.textMuted : "#fff"} />
        ) : (
          <Tv size={14} color={isCustom ? theme.textMuted : "#fff"} />
        )}
      </div>
      {item.favorite && (
        <div style={{ position: "absolute", top: 6, right: 6 }}>
          <Heart size={16} color={ACCENT} fill={ACCENT} />
        </div>
      )}
      {children}
    </div>
  );
}

// --- Tab style variants -----------------------------------------------------

function TabsPill({ active, onSelect, theme }) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onSelect(tab.key)}
            style={{
              flex: 1,
              padding: "8px 4px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              border: `1px solid ${isActive ? ACCENT : theme.border}`,
              background: isActive ? ACCENT : "transparent",
              color: isActive ? "#1D1400" : theme.textMuted,
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function TabsUnderline({ active, onSelect, theme }) {
  return (
    <div style={{ display: "flex", gap: 18, marginBottom: 14, borderBottom: `1px solid ${theme.border}` }}>
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onSelect(tab.key)}
            style={{
              background: "none",
              border: "none",
              padding: "0 0 10px",
              fontSize: 13,
              fontWeight: 600,
              color: isActive ? theme.text : theme.textMuted,
              borderBottom: `2px solid ${isActive ? ACCENT : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function TabsSegmented({ active, onSelect, theme }) {
  return (
    <div style={{ display: "flex", background: theme.surfaceAlt, borderRadius: 12, padding: 3, gap: 3, marginBottom: 14 }}>
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onSelect(tab.key)}
            style={{
              flex: 1,
              padding: "7px 2px",
              borderRadius: 9,
              fontSize: 11.5,
              fontWeight: 600,
              border: "none",
              background: isActive ? theme.surface : "transparent",
              color: isActive ? theme.text : theme.textMuted,
              boxShadow: isActive ? "0 1px 3px rgba(0,0,0,0.15)" : "none",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function iconButtonStyle(theme) {
  return {
    background: theme.surfaceAlt,
    border: `1px solid ${theme.border}`,
    borderRadius: 999,
    width: 34,
    height: 34,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: theme.textMuted,
  };
}

const TAB_STYLES = { pill: TabsPill, underline: TabsUnderline, segmented: TabsSegmented };

// ---------------------------------------------------------------------------

// --- Timeline screen ---------------------------------------------------

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function dateSortKey(str) {
  const [mon, day] = str.split(" ");
  return (MONTHS[mon] ?? 0) * 31 + parseInt(day, 10);
}

function TimelineScreen({ items, theme, onSelect }) {
  const entries = [];
  items.forEach((item) => {
    if (item.type === "show" && item.seasons) {
      item.seasons.forEach((season) => {
        season.episodes.forEach((ep) => {
          if (!ep.watched) {
            entries.push({
              date: ep.airDate,
              title: item.title,
              sub: `S${season.number} · E${ep.number} · ${ep.title}`,
              item,
            });
          }
        });
      });
    }
  });
  // One synthetic upcoming movie release, for a mixed episodes+movie timeline
  const upcomingMovie = items.find((i) => i.title === "Paper Moths");
  if (upcomingMovie) {
    entries.push({ date: "Apr 18", title: upcomingMovie.title, sub: "Release date", item: upcomingMovie });
  }
  entries.sort((a, b) => dateSortKey(a.date) - dateSortKey(b.date));

  const grouped = [];
  entries.forEach((e) => {
    const last = grouped[grouped.length - 1];
    if (last && last.date === e.date) last.entries.push(e);
    else grouped.push({ date: e.date, entries: [e] });
  });

  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "4px 20px 24px" }}>
      {grouped.length === 0 && (
        <div style={{ color: theme.textMuted, fontSize: 13, padding: "40px 0", textAlign: "center" }}>
          Nothing upcoming right now.
        </div>
      )}
      {grouped.map((g) => (
        <div key={g.date} style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: ACCENT, marginBottom: 10 }}>
            {g.date}
          </div>
          {g.entries.map((e, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(e.item)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                width: "100%",
                padding: "8px 0",
                background: "none",
                border: "none",
                borderBottom: `1px solid ${theme.border}`,
                textAlign: "left",
              }}
            >
              <div
                style={{
                  width: 36,
                  aspectRatio: "2 / 3",
                  borderRadius: 8,
                  flexShrink: 0,
                  background:
                    e.item.source === "custom"
                      ? theme.surfaceAlt
                      : `linear-gradient(155deg, ${GENRES[e.item.genre][0]}, ${GENRES[e.item.genre][1]})`,
                  border: e.item.source === "custom" ? `1px dashed ${theme.border}` : "none",
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{e.title}</div>
                <div style={{ fontSize: 11.5, color: theme.textMuted }}>{e.sub}</div>
              </div>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// --- Settings screen -----------------------------------------------------

function SettingsSection({ title, theme, children, "data-spec-ref": specRef }) {
  return (
    <div data-spec-ref={specRef} style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: theme.textMuted, marginBottom: 10 }}>
        {title}
      </div>
      <div style={{ background: theme.surfaceAlt, borderRadius: 12, overflow: "hidden" }}>{children}</div>
    </div>
  );
}

function SettingsRow({ theme, children, last }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 14px",
        borderBottom: last ? "none" : `1px solid ${theme.border}`,
      }}
    >
      {children}
    </div>
  );
}

function SettingsScreen({ theme, themeMode, setThemeMode }) {
  const [subs, setSubs] = useState([
    { id: 1, label: "iPhone — Safari", meta: "Last used today" },
    { id: 2, label: "MacBook — Chrome", meta: "Last used 3 days ago" },
  ]);

  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "4px 20px 24px" }}>
      <SettingsSection title="Account" theme={theme}>
        <SettingsRow theme={theme}>
          <div style={{ flex: 1, fontSize: 13, color: theme.text }}>paul@example.com</div>
        </SettingsRow>
        <SettingsRow theme={theme} last>
          <button type="button" style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", color: "#C4483D", fontSize: 13, fontWeight: 600 }}>
            <LogOut size={15} />
            Log out
          </button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Notifications" theme={theme} data-spec-ref="settings-notifications-section">
        {subs.length === 0 && (
          <SettingsRow theme={theme} last>
            <div style={{ fontSize: 12.5, color: theme.textMuted }}>No devices subscribed.</div>
          </SettingsRow>
        )}
        {subs.map((s, i) => (
          <SettingsRow key={s.id} theme={theme} last={i === subs.length - 1}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{s.label}</div>
              <div style={{ fontSize: 11, color: theme.textMuted }}>{s.meta}</div>
            </div>
            <button
              type="button"
              onClick={() => setSubs(subs.filter((x) => x.id !== s.id))}
              style={{
                width: 26,
                height: 26,
                borderRadius: 999,
                border: `1px solid ${theme.border}`,
                background: "transparent",
                color: theme.textMuted,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Unsubscribe this device"
            >
              <X size={13} />
            </button>
          </SettingsRow>
        ))}
      </SettingsSection>

      <SettingsSection title="Appearance" theme={theme} data-spec-ref="settings-appearance-section">
        <SettingsRow theme={theme} last>
          <div style={{ display: "flex", gap: 6, width: "100%" }}>
            {["auto", "light", "dark"].map((mode) => {
              const isActive = themeMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setThemeMode(mode)}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    borderRadius: 9,
                    fontSize: 12.5,
                    fontWeight: 600,
                    textTransform: "capitalize",
                    border: `1px solid ${isActive ? ACCENT : theme.border}`,
                    background: isActive ? ACCENT : theme.surface,
                    color: isActive ? "#1D1400" : theme.text,
                  }}
                >
                  {mode}
                </button>
              );
            })}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Data" theme={theme}>
        <SettingsRow theme={theme}>
          <div style={{ flex: 1, fontSize: 13, color: theme.text }}>Export my data</div>
        </SettingsRow>
        <SettingsRow theme={theme} last>
          <div style={{ flex: 1, fontSize: 13, color: theme.text }}>Import from TV Time</div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

// --- Search screen ---------------------------------------------------------

function SearchScreen({ theme, networkMode, items, catalog, query, setQuery, openItem, isTracked, onAddFromCatalog, onCreateCustom }) {
  const [customType, setCustomType] = useState("movie");

  // Your own custom (unlinked) entries are always searchable by you, in every
  // network mode — network condition only changes what backs the *external*
  // part of the results (live TMDB, the shared linked-only fallback, or nothing).
  const myCustom = items.filter((i) => i.source === "custom");
  const pool =
    networkMode === "up"
      ? [...catalog, ...myCustom]
      : networkMode === "down"
      ? [...items.filter((i) => i.source !== "custom"), ...myCustom]
      : items;

  const trimmed = query.trim();
  const results = trimmed ? pool.filter((i) => i.title.toLowerCase().includes(trimmed.toLowerCase())) : [];

  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "4px 20px 24px" }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search movies and shows"
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 10,
          border: `1px solid ${theme.border}`,
          background: theme.surfaceAlt,
          color: theme.text,
          fontSize: 14,
          marginBottom: 14,
        }}
      />

      {networkMode !== "up" && trimmed && (
        <div
          data-spec-ref="search-degraded-offline-banner"
          style={{
            fontSize: 12,
            color: theme.textMuted,
            background: theme.surfaceAlt,
            borderRadius: 10,
            padding: "9px 11px",
            marginBottom: 14,
            lineHeight: 1.4,
          }}
        >
          {networkMode === "down"
            ? "TMDB is unreachable — showing results from the shared library only."
            : "You're offline — showing your own list only."}
        </div>
      )}

      {trimmed &&
        results.map((r) => {
          const tracked = isTracked(r.id);
          return (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${theme.border}` }}>
              <div style={{ width: 36 }}>
                <PosterTile item={r} theme={theme} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{r.title}</div>
                <div style={{ fontSize: 11, color: theme.textMuted }}>
                  {r.yearLabel || r.year} · {r.type === "movie" ? "Movie" : "Show"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => (tracked ? openItem(items.find((i) => i.id === r.id)) : onAddFromCatalog(r))}
                style={{
                  padding: "6px 13px",
                  borderRadius: 999,
                  border: tracked ? `1px solid ${theme.border}` : "none",
                  background: tracked ? "transparent" : ACCENT,
                  color: tracked ? theme.textMuted : "#1D1400",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {tracked ? "Open" : "Add"}
              </button>
            </div>
          );
        })}

      {trimmed && results.length === 0 && (
        <div style={{ color: theme.textMuted, fontSize: 13, padding: "8px 0 16px" }}>No matches.</div>
      )}

      {trimmed && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px dashed ${theme.border}` }}>
          <div style={{ fontSize: 12.5, color: theme.textMuted, marginBottom: 10 }}>Can't find it?</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {["movie", "show"].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setCustomType(t)}
                style={{
                  padding: "5px 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  border: `1px solid ${customType === t ? ACCENT : theme.border}`,
                  background: customType === t ? ACCENT : "transparent",
                  color: customType === t ? "#1D1400" : theme.textMuted,
                }}
              >
                {t === "movie" ? "Movie" : "Show"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onCreateCustom(trimmed, customType)}
            style={{
              width: "100%",
              padding: "10px 0",
              borderRadius: 12,
              border: `1px solid ${ACCENT}`,
              background: "transparent",
              color: ACCENT,
              fontWeight: 700,
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <Link2 size={14} />
            Add "{trimmed}" manually
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function WatchlistConcept() {
  const [themeMode, setThemeMode] = useState("auto"); // 'auto' | 'light' | 'dark'
  const systemDark = useSystemDark();
  const windowWidth = useWindowWidth();
  const isDesktop = windowWidth >= 860;
  const dark = themeMode === "auto" ? systemDark : themeMode === "dark";
  const [screen, setScreen] = useState("home"); // 'home' | 'timeline' | 'settings' | 'search'
  const [items, setItems] = useState(SHOWS);
  const [activeTab, setActiveTab] = useState("want_to_watch");
  const [tabStyle, setTabStyle] = useState("segmented");
  const [typeFilter, setTypeFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [yearFilter, setYearFilter] = useState(null);
  const [genreFilter, setGenreFilter] = useState(null);
  const [selected, setSelected] = useState(null);
  const [activeSeason, setActiveSeason] = useState(0);
  const [linkSearchOpen, setLinkSearchOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [completing, setCompleting] = useState({}); // { [itemId]: 'flash' | 'fading' }
  const [networkMode, setNetworkMode] = useState("up"); // 'up' | 'down' | 'offline'
  const [searchQuery, setSearchQuery] = useState("");
  const theme = useTheme(dark);

  const handleLink = (candidate) => {
    const updated = enrich(
      { ...selected, source: undefined, yearLabel: undefined, year: candidate.year },
      selected.id
    );
    setItems(items.map((i) => (i.id === selected.id ? updated : i)));
    setSelected(updated);
    setLinkSearchOpen(false);
  };

  const nextEpisodeOf = (item) => {
    if (item.type !== "show" || !item.seasons) return null;
    const season = item.seasons[item.seasons.length - 1];
    const ep = season.episodes.find((e) => !e.watched);
    return ep ? { season, ep } : null;
  };

  const markNextEpisodeWatched = (item) => {
    const seasons = item.seasons.map((s, si) => {
      if (si !== item.seasons.length - 1) return s;
      let marked = false;
      const episodes = s.episodes.map((ep) => {
        if (!marked && !ep.watched) {
          marked = true;
          return { ...ep, watched: true };
        }
        return ep;
      });
      return { ...s, episodes };
    });
    const updated = { ...item, seasons };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    if (selected && selected.id === item.id) setSelected(updated);

    if (computeProgress(updated) === 1) {
      // Two-phase completion: flash the finished state so it's clear what happened,
      // then fade the card out, then actually move it to Completed.
      setCompleting((c) => ({ ...c, [item.id]: "flash" }));
      setTimeout(() => setCompleting((c) => ({ ...c, [item.id]: "fading" })), 900);
      setTimeout(() => {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: "completed" } : i)));
        setCompleting((c) => {
          const { [item.id]: _drop, ...rest } = c;
          return rest;
        });
      }, 900 + 550);
    }
  };

  const continueWatching = items.filter((s) => s.status === "watching" && computeProgress(s) !== undefined);

  const inTab = items.filter((s) => (activeTab === "favorites" ? s.favorite : s.status === activeTab));
  const availableYearBuckets = Array.from(
    new Set(inTab.filter((s) => typeFilter === "all" || s.type === typeFilter).map(bucketFor))
  );
  const availableGenres = Array.from(
    new Set(inTab.filter((s) => typeFilter === "all" || s.type === typeFilter).map((s) => s.genre))
  );

  const listed = inTab.filter((s) => {
    if (typeFilter !== "all" && s.type !== typeFilter) return false;
    if (yearFilter && bucketFor(s) !== yearFilter) return false;
    if (genreFilter && s.genre !== genreFilter) return false;
    return true;
  });

  const isTracked = (id) => items.some((i) => i.id === id);

  const handleAddFromCatalog = (catalogItem) => {
    setItems((prev) => [...prev, catalogItem]);
  };

  const handleCreateCustom = (title, type) => {
    const newId = Math.max(0, ...items.map((i) => i.id)) + 1000;
    const newItem = {
      id: newId,
      title,
      type,
      genre: "drama",
      yearLabel: undefined,
      source: "custom",
      status: "want_to_watch",
      favorite: false,
      watched: false,
    };
    setItems((prev) => [...prev, newItem]);
    setSearchQuery("");
    openItem(newItem);
  };

  const openItem = (item) => {
    setActiveSeason(0);
    setLinkSearchOpen(false);
    setDetailsOpen(!(item.type === "show" && item.status === "watching"));
    setSelected(item);
  };

  const TabComponent = TAB_STYLES[tabStyle];
  const chip = (isActive) => ({
    padding: "5px 11px",
    borderRadius: 999,
    fontSize: 11.5,
    fontWeight: 600,
    border: `1px solid ${isActive ? ACCENT : theme.border}`,
    background: isActive ? ACCENT : "transparent",
    color: isActive ? "#1D1400" : theme.textMuted,
    flexShrink: 0,
  });

  const renderDetailBody = () => (
    <>
                <div
                style={{
                  height: 220,
                  background:
                    selected.source === "custom"
                      ? theme.surfaceAlt
                      : `linear-gradient(155deg, ${GENRES[selected.genre][0]}, ${GENRES[selected.genre][1]})`,
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  padding: 16,
                }}
              >
                <div style={{ position: "absolute", inset: 0, background: theme.scrim, pointerEvents: "none" }} />
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  style={{
                    position: "relative",
                    zIndex: 2,
                    background: "rgba(0,0,0,0.45)",
                    border: "none",
                    borderRadius: 999,
                    padding: "7px 14px 7px 10px",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    color: "#fff",
                    alignSelf: "flex-start",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  <ChevronLeft size={18} />
                  Back
                </button>
              </div>

              <div style={{ padding: "16px 20px 20px", position: "relative" }}>
                <div className="fraunces" style={{ fontSize: 24, fontWeight: 600, color: theme.text, marginTop: -36, position: "relative" }}>
                  {selected.title}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, marginBottom: 18, flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: theme.textMuted,
                      border: `1px solid ${theme.border}`,
                      borderRadius: 999,
                      padding: "3px 9px",
                    }}
                  >
                    {selected.type === "movie" ? "Movie" : "Show"} · {selected.yearLabel || selected.year}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: theme.textMuted,
                      border: `1px solid ${theme.border}`,
                      borderRadius: 999,
                      padding: "3px 9px",
                    }}
                  >
                    {selected.status.replace(/_/g, " ")}
                  </span>
                  {selected.source === "custom" && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: theme.textMuted,
                        border: `1px dashed ${theme.border}`,
                        borderRadius: 999,
                        padding: "3px 9px",
                      }}
                    >
                      Not yet matched
                    </span>
                  )}
                  <button style={{ marginLeft: "auto", background: "none", border: "none", display: "flex", alignItems: "center" }}>
                    <Heart size={20} color={ACCENT} fill={selected.favorite ? ACCENT : "none"} />
                  </button>
                </div>

                {selected.source === "custom" ? (
                  <div style={{ padding: "14px 4px 6px", borderTop: `1px dashed ${theme.border}`, marginBottom: 8 }}>
                    <p style={{ color: theme.textMuted, fontSize: 13, lineHeight: 1.5, margin: "0 0 14px" }}>
                      No overview, cast, or artwork yet — this was added manually and hasn't been matched to a
                      database entry. We'll check periodically and let you review a match if one turns up — or you
                      can look for one yourself now.
                    </p>

                    {!linkSearchOpen ? (
                      <button
                        type="button"
                        onClick={() => setLinkSearchOpen(true)}
                        data-spec-ref="custom-entry-manual-link-button"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 8,
                          width: "100%",
                          padding: "11px 0",
                          borderRadius: 12,
                          border: `1px solid ${ACCENT}`,
                          background: "transparent",
                          color: ACCENT,
                          fontWeight: 700,
                          fontSize: 13,
                        }}
                      >
                        <Link2 size={15} />
                        Search for a match
                      </button>
                    ) : (
                      <div>
                        <input
                          defaultValue={selected.title}
                          readOnly
                          style={{
                            width: "100%",
                            padding: "9px 12px",
                            borderRadius: 10,
                            border: `1px solid ${theme.border}`,
                            background: theme.surfaceAlt,
                            color: theme.text,
                            fontSize: 13,
                            marginBottom: 10,
                          }}
                        />
                        <div style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                          Possible matches
                        </div>
                        {LINK_CANDIDATES.map((c) => (
                          <div
                            key={c.label + c.year}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "8px 0",
                              borderBottom: `1px solid ${theme.border}`,
                            }}
                          >
                            <div
                              style={{
                                width: 32,
                                aspectRatio: "2 / 3",
                                borderRadius: 6,
                                flexShrink: 0,
                                background: `linear-gradient(155deg, ${GENRES[selected.genre][0]}, ${GENRES[selected.genre][1]})`,
                              }}
                            />
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 600, color: theme.text }}>{c.label}</div>
                              <div style={{ fontSize: 11, color: theme.textMuted }}>{c.year}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleLink(c)}
                              style={{
                                padding: "6px 12px",
                                borderRadius: 999,
                                border: "none",
                                background: ACCENT,
                                color: "#1D1400",
                                fontWeight: 700,
                                fontSize: 12,
                              }}
                            >
                              Link
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Rating + runtime meta row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <Star size={15} color={ACCENT} fill={ACCENT} />
                        <span style={{ fontSize: 13, fontWeight: 700, color: theme.text }}>{selected.rating}</span>
                        <span style={{ fontSize: 11, color: theme.textMuted }}>/10</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <Clock size={14} color={theme.textMuted} />
                        <span style={{ fontSize: 12, color: theme.textMuted }}>
                          {selected.type === "movie" ? `${selected.runtime} min` : `${selected.runtime} min / ep`}
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: theme.textMuted,
                          background: theme.surfaceAlt,
                          borderRadius: 999,
                          padding: "3px 9px",
                        }}
                      >
                        {GENRE_LABELS[selected.genre]}
                      </span>
                    </div>

                    {/* Quick-mark next episode — the fast path, no scrolling to the episode list needed */}
                    {selected.type === "show" &&
                      (() => {
                        const next = nextEpisodeOf(selected);
                        if (!next) return null;
                        return (
                          <button
                            type="button"
                            onClick={() => markNextEpisodeWatched(selected)}
                            data-spec-ref="detail-quick-mark-next-episode"
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              width: "100%",
                              padding: "10px 12px",
                              borderRadius: 12,
                              border: `1px solid ${theme.border}`,
                              background: theme.surfaceAlt,
                              marginBottom: 16,
                              textAlign: "left",
                            }}
                          >
                            <div
                              style={{
                                width: 26,
                                height: 26,
                                borderRadius: 999,
                                border: `1.5px solid ${ACCENT}`,
                                flexShrink: 0,
                              }}
                            />
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>
                                Next: S{next.season.number} · E{next.ep.number} · {next.ep.title}
                              </div>
                            </div>
                            <span style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>Mark watched</span>
                          </button>
                        );
                      })()}

                    {/* Collapsible: description, cast, trailer — collapsed by default while a show is in progress,
                        so the episode list is one tap away instead of a scroll away */}
                    <button
                      type="button"
                      onClick={() => setDetailsOpen(!detailsOpen)}
                      data-spec-ref="detail-collapsible-details-toggle"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        background: "none",
                        border: "none",
                        padding: "0 0 10px",
                        fontSize: 11,
                        fontWeight: 700,
                        color: theme.textMuted,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      <ChevronDown size={13} style={{ transform: detailsOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }} />
                      Details
                    </button>

                    {detailsOpen && (
                      <>
                        {/* Overview */}
                        <p style={{ fontSize: 13, lineHeight: 1.55, color: theme.text, marginTop: 0, marginBottom: 18 }}>
                          {selected.overview}
                        </p>

                        {/* Cast */}
                        <div
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: theme.textMuted,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            marginBottom: 8,
                          }}
                        >
                          Cast
                        </div>
                        <div className="no-scrollbar" style={{ display: "flex", gap: 14, overflowX: "auto", marginBottom: 20, paddingBottom: 2 }}>
                          {selected.cast.map((c, i) => (
                            <div key={i} style={{ flexShrink: 0, width: 64, textAlign: "center" }}>
                              <XPlaceholder width={56} height={56} radius={999} theme={theme} />
                              <div style={{ fontSize: 11, fontWeight: 600, color: theme.text, marginTop: 6, lineHeight: 1.2 }}>
                                {c.name}
                              </div>
                              <div style={{ fontSize: 10, color: theme.textMuted }}>{c.role}</div>
                            </div>
                          ))}
                        </div>

                        {/* Trailer */}
                        <div
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: theme.textMuted,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            marginBottom: 8,
                          }}
                        >
                          Trailer
                        </div>
                        <div style={{ position: "relative", marginBottom: 20 }}>
                          <XPlaceholder width="100%" height={150} radius={12} theme={theme} />
                          <div
                            style={{
                              position: "absolute",
                              inset: 0,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <div
                              style={{
                                width: 44,
                                height: 44,
                                borderRadius: 999,
                                background: ACCENT,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <Play size={18} color="#1D1400" fill="#1D1400" />
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </>
                )}

                {selected.type === "movie" ? (
                  <button

                    style={{
                      width: "100%",
                      padding: "12px 0",
                      borderRadius: 12,
                      border: "none",
                      background: selected.watched ? theme.surfaceAlt : ACCENT,
                      color: selected.watched ? theme.text : "#1D1400",
                      fontWeight: 700,
                      fontSize: 14,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                    }}
                  >
                    {selected.watched && <Check size={16} />}
                    {selected.watched ? "Watched" : "Mark as watched"}
                  </button>
                ) : (
                  <>
                    <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                      {selected.seasons.map((s, i) => (
                        <button
                          key={s.number}
                          type="button"
                          onClick={() => setActiveSeason(i)}
                          style={{
                            padding: "6px 12px",
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 600,
                            border: `1px solid ${i === activeSeason ? ACCENT : theme.border}`,
                            background: i === activeSeason ? ACCENT : "transparent",
                            color: i === activeSeason ? "#1D1400" : theme.textMuted,
                          }}
                        >
                          Season {s.number}
                        </button>
                      ))}
                    </div>
                    <div>
                      {selected.seasons[activeSeason].episodes.map((ep) => (
                        <div
                          key={ep.number}
                          style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${theme.border}` }}
                        >
                          <div style={{ width: 22, fontSize: 12, color: theme.textMuted, fontWeight: 600 }}>{ep.number}</div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{ep.title}</div>
                            <div style={{ fontSize: 11, color: theme.textMuted }}>{ep.airDate}</div>
                          </div>
                          <div
                            style={{
                              width: 24,
                              height: 24,
                              borderRadius: 999,
                              border: `1.5px solid ${ep.watched ? ACCENT : theme.border}`,
                              background: ep.watched ? ACCENT : "transparent",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            {ep.watched && <Check size={13} color="#1D1400" />}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
    </>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0A0A0B",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 12px",
        fontFamily: "'Public Sans', sans-serif",
        gap: 14,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,500&family=Public+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        .fraunces { font-family: 'Fraunces', serif; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        button { font-family: inherit; cursor: pointer; }
        @keyframes popIn { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.25); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
        .pop-in { animation: popIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1); }
      `}</style>

      {/* Dev-only preview controls (not part of the app) */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", justifyContent: "center", maxWidth: 500, color: "#8A8880", fontSize: 11, fontFamily: "'Public Sans', sans-serif" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span>Tab style (preview only):</span>
          {Object.keys(TAB_STYLES).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTabStyle(key)}
              style={{
                padding: "4px 9px",
                borderRadius: 999,
                border: `1px solid ${tabStyle === key ? ACCENT : "#333"}`,
                background: tabStyle === key ? ACCENT : "transparent",
                color: tabStyle === key ? "#1D1400" : "#8A8880",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {key}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span>Network (search behavior):</span>
          {[
            { key: "up", label: "TMDB up" },
            { key: "down", label: "TMDB down" },
            { key: "offline", label: "Offline" },
          ].map((n) => (
            <button
              key={n.key}
              type="button"
              onClick={() => setNetworkMode(n.key)}
              style={{
                padding: "4px 9px",
                borderRadius: 999,
                border: `1px solid ${networkMode === n.key ? ACCENT : "#333"}`,
                background: networkMode === n.key ? ACCENT : "transparent",
                color: networkMode === n.key ? "#1D1400" : "#8A8880",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {n.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {dark ? <Moon size={12} /> : <Sun size={12} />}
          {themeMode === "auto" ? `Auto (${dark ? "dark" : "light"}, from system)` : themeMode}
        </div>
        <div>Viewport: {windowWidth}px — {isDesktop ? "desktop layout" : "phone layout"}</div>
      </div>

      {/* App shell — phone bezel on narrow viewports, full-width layout on desktop */}
      <div
        style={{
          width: isDesktop ? Math.min(windowWidth - 64, 1040) : 390,
          height: isDesktop ? "80vh" : 780,
          maxHeight: isDesktop ? 820 : undefined,
          borderRadius: isDesktop ? 20 : 40,
          background: theme.bg,
          border: isDesktop ? `1px solid ${theme.border}` : "10px solid #050506",
          boxShadow: isDesktop ? "0 20px 50px rgba(0,0,0,0.25)" : "0 30px 60px rgba(0,0,0,0.5)",
          overflow: "hidden",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          transition: "width 0.15s ease, border-radius 0.15s ease",
        }}
      >
        {/* Header */}
        <div style={{ padding: "20px 20px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          {screen === "home" ? (
            <>
              <div className="fraunces" style={{ fontSize: 22, fontWeight: 600, color: theme.text }}>
                Marquee
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setScreen("timeline")}
                  style={iconButtonStyle(theme)}
                  title="Timeline"
                >
                  <CalendarDays size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setScreen("settings")}
                  style={iconButtonStyle(theme)}
                  title="Settings"
                >
                  <Settings size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setScreen("search")}
                  style={{ ...iconButtonStyle(theme), background: ACCENT, borderColor: ACCENT, color: "#1D1400" }}
                  title="Search"
                >
                  <Search size={16} />
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setScreen("home")}
              style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: theme.text, fontSize: 15, fontWeight: 600 }}
            >
              <ChevronLeft size={20} />
              {screen === "timeline" ? "Timeline" : screen === "settings" ? "Settings" : "Search"}
            </button>
          )}
        </div>


        {/* Home screen */}
        {screen === "home" && (
          <div className="no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "4px 20px 24px" }}>
            {/* Continue watching */}
            <div data-spec-ref="continue-watching-section" style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: theme.textMuted, marginBottom: 10 }}>
                Continue Watching
              </div>
              <div className="no-scrollbar" style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
                {continueWatching.map((item) => {
                  const season = item.seasons[item.seasons.length - 1];
                  const nextEp = season.episodes.find((e) => !e.watched);
                  const phase = completing[item.id]; // undefined | 'flash' | 'fading'
                  const isDone = !nextEp || phase;
                  const fading = phase === "fading";
                  return (
                    <div
                      key={item.id}
                      onClick={() => !fading && openItem(item)}
                      style={{
                        width: fading ? 0 : 120,
                        marginRight: fading ? 0 : undefined,
                        flexShrink: 0,
                        textAlign: "left",
                        cursor: fading ? "default" : "pointer",
                        opacity: fading ? 0 : 1,
                        overflow: "hidden",
                        transition: "opacity 0.5s ease, width 0.5s ease",
                      }}
                    >
                      <div style={{ width: 120 }}>
                        <PosterTile item={item} theme={theme}>
                          <div
                            style={{
                              position: "absolute",
                              bottom: 6,
                              right: 6,
                              width: 34,
                              height: 34,
                              borderRadius: 999,
                              background: "rgba(0,0,0,0.55)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <ProgressRing progress={isDone ? 1 : computeProgress(item)} size={34} theme={theme} />
                            {isDone ? (
                              <Check
                                key={phase || "done"}
                                size={15}
                                color={ACCENT}
                                strokeWidth={3}
                                className={phase === "flash" ? "pop-in" : ""}
                                style={{ position: "absolute" }}
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  markNextEpisodeWatched(item);
                                }}
                                title={`Mark E${nextEp.number} watched`}
                                data-spec-ref="continue-watching-quickmark"
                                style={{
                                  position: "absolute",
                                  inset: 0,
                                  background: "none",
                                  border: "none",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                <Check size={13} color="#fff" />
                              </button>
                            )}
                          </div>
                        </PosterTile>
                        <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginTop: 8, lineHeight: 1.25 }}>{item.title}</div>
                        <div style={{ fontSize: 11, color: phase ? ACCENT : theme.textMuted, marginTop: 2, fontWeight: phase ? 700 : 400 }}>
                          {phase ? "Completed!" : `S${season.number} · E${nextEp ? nextEp.number : season.episodes.length}`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Main list tabs (style controlled by dev switcher above) */}
            <div data-spec-ref="list-tabs">
              <TabComponent active={activeTab} onSelect={setActiveTab} theme={theme} />
            </div>

            {/* Type filter — always visible */}
            <div data-spec-ref="list-type-genre-year-filters" style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {[
                { key: "all", label: "All" },
                { key: "movie", label: "Movies" },
                { key: "show", label: "Shows" },
              ].map((t) => (
                <button key={t.key} type="button" onClick={() => setTypeFilter(t.key)} style={chip(typeFilter === t.key)}>
                  {t.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setFiltersOpen(!filtersOpen)}
                style={{
                  marginLeft: "auto",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 11px",
                  borderRadius: 999,
                  fontSize: 11.5,
                  fontWeight: 600,
                  border: `1px solid ${filtersOpen || yearFilter || genreFilter ? ACCENT : theme.border}`,
                  background: "transparent",
                  color: filtersOpen || yearFilter || genreFilter ? ACCENT : theme.textMuted,
                }}
              >
                <SlidersHorizontal size={12} />
                Filters
              </button>
            </div>

            {/* Expandable filters: year + genre */}
            {filtersOpen && (
              <div style={{ marginBottom: 12, padding: 10, borderRadius: 10, background: theme.surfaceAlt }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                  Year
                </div>
                <div className="no-scrollbar" style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 10 }}>
                  <button type="button" onClick={() => setYearFilter(null)} style={chip(!yearFilter)}>
                    Any
                  </button>
                  {availableYearBuckets.map((b) => (
                    <button key={b} type="button" onClick={() => setYearFilter(b)} style={chip(yearFilter === b)}>
                      {b}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                  Genre
                </div>
                <div className="no-scrollbar" style={{ display: "flex", gap: 6, overflowX: "auto" }}>
                  <button type="button" onClick={() => setGenreFilter(null)} style={chip(!genreFilter)}>
                    Any
                  </button>
                  {availableGenres.map((g) => (
                    <button key={g} type="button" onClick={() => setGenreFilter(g)} style={chip(genreFilter === g)}>
                      {GENRE_LABELS[g]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 10 }}>
              {listed.map((item) => (
                <button key={item.id} type="button" onClick={() => openItem(item)} style={{ background: "none", border: "none", padding: 0, textAlign: "left" }}>
                  <PosterTile item={item} theme={theme} />
                  <div style={{ fontSize: 12, fontWeight: 600, color: theme.text, marginTop: 6, lineHeight: 1.25 }}>{item.title}</div>
                  <div style={{ fontSize: 10.5, color: theme.textMuted }}>{item.yearLabel || item.year}</div>
                </button>
              ))}
              {listed.length === 0 && (
                <div style={{ gridColumn: "span 3", color: theme.textMuted, fontSize: 13, padding: "24px 0", textAlign: "center" }}>
                  Nothing matches these filters.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Timeline screen */}
        {screen === "timeline" && <TimelineScreen items={items} theme={theme} onSelect={openItem} />}

        {/* Settings screen */}
        {screen === "settings" && <SettingsScreen theme={theme} themeMode={themeMode} setThemeMode={setThemeMode} />}

        {screen === "search" && (
          <SearchScreen
            theme={theme}
            networkMode={networkMode}
            items={items}
            catalog={TMDB_CATALOG}
            query={searchQuery}
            setQuery={setSearchQuery}
            openItem={openItem}
            isTracked={isTracked}
            onAddFromCatalog={handleAddFromCatalog}
            onCreateCustom={handleCreateCustom}
          />
        )}

        {/* Detail sheet — full-bleed on phone, centered modal on desktop */}
        {selected &&
          (isDesktop ? (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.55)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 10,
              }}
              onClick={() => setSelected(null)}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: 440,
                  maxHeight: "82vh",
                  background: theme.bg,
                  borderRadius: 20,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                  boxShadow: "0 30px 70px rgba(0,0,0,0.4)",
                }}
              >
                <div className="no-scrollbar" style={{ flex: 1, overflowY: "auto" }}>{renderDetailBody()}</div>
              </div>
            </div>
          ) : (
            <div style={{ position: "absolute", inset: 0, background: theme.bg, display: "flex", flexDirection: "column" }}>
              <div className="no-scrollbar" style={{ flex: 1, overflowY: "auto" }}>{renderDetailBody()}</div>
            </div>
          ))}
      </div>
    </div>
  );
}
