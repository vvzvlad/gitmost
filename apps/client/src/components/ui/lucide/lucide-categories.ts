// Category-slug → i18n key (the English title, which is also the translation
// key — en-US is the source of truth). Hand-maintained.
//
// Seeded with ALL 42 lucide repo-tag category slugs (including ones that are no
// icon's FIRST category today) so a lucide bump that promotes a new first
// category never reddens the guard test, PLUS our own `other` slug for icons
// with no category (the `--offline` degraded path). The guard test asserts every
// `primary` slug has an entry here.
export const CATEGORY_TITLES: Record<string, string> = {
  accessibility: "Accessibility",
  account: "Account",
  animals: "Animals",
  arrows: "Arrows",
  buildings: "Buildings",
  charts: "Charts",
  communication: "Communication",
  connectivity: "Connectivity",
  cursors: "Cursors",
  design: "Design",
  development: "Development",
  devices: "Devices",
  emoji: "Emoji",
  files: "Files",
  finance: "Finance",
  "food-beverage": "Food & beverage",
  gaming: "Gaming",
  // "Household", NOT "Home": the bare "Home" i18n key already means the app's
  // navigation Home ("Главная" in ru), a different sense than this lucide
  // category of house/furniture icons ("Дом"). A distinct key avoids the clash.
  home: "Household",
  layout: "Layout",
  mail: "Mail",
  math: "Math",
  medical: "Medical",
  multimedia: "Multimedia",
  nature: "Nature",
  navigation: "Navigation",
  notifications: "Notifications",
  people: "People",
  photography: "Photography",
  science: "Science",
  seasons: "Seasons",
  security: "Security",
  shapes: "Shapes",
  shopping: "Shopping",
  social: "Social",
  sports: "Sports",
  sustainability: "Sustainability",
  text: "Text",
  time: "Time",
  tools: "Tools",
  transportation: "Transportation",
  travel: "Travel",
  weather: "Weather",
  // Our own slug (NOT a lucide category): icons with no category, e.g. new icons
  // under `--offline`. Rendered LAST, after the alphabetical category sections.
  other: "Other",
};

// The slug our generator assigns to icons that have no lucide category.
export const OTHER_SLUG = "other";
