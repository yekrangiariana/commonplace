import { normalizeTag, dedupeTags } from "../taxonomy.js";

const DEFAULT_COUNTRY_RULES = [
  {
    tag: "united states",
    keywords: ["united states", "usa", "u.s.", "american", "americans"],
  },
  {
    tag: "united kingdom",
    keywords: ["united kingdom", "uk", "britain", "british"],
  },
  { tag: "canada", keywords: ["canada", "canadian", "canadians"] },
  { tag: "mexico", keywords: ["mexico", "mexican", "mexicans"] },
  { tag: "brazil", keywords: ["brazil", "brazilian", "brazilians"] },
  { tag: "argentina", keywords: ["argentina", "argentine", "argentinian"] },
  { tag: "chile", keywords: ["chile", "chilean", "chileans"] },
  { tag: "colombia", keywords: ["colombia", "colombian", "colombians"] },
  { tag: "peru", keywords: ["peru", "peruvian", "peruvians"] },
  { tag: "france", keywords: ["france", "french"] },
  { tag: "germany", keywords: ["germany", "german", "germans"] },
  { tag: "spain", keywords: ["spain", "spanish", "spaniards"] },
  { tag: "italy", keywords: ["italy", "italian", "italians"] },
  { tag: "portugal", keywords: ["portugal", "portuguese"] },
  { tag: "netherlands", keywords: ["netherlands", "dutch"] },
  { tag: "belgium", keywords: ["belgium", "belgian", "belgians"] },
  { tag: "switzerland", keywords: ["switzerland", "swiss"] },
  { tag: "austria", keywords: ["austria", "austrian", "austrians"] },
  { tag: "sweden", keywords: ["sweden", "swedish"] },
  { tag: "norway", keywords: ["norway", "norwegian", "norwegians"] },
  { tag: "denmark", keywords: ["denmark", "danish"] },
  { tag: "finland", keywords: ["finland", "finnish", "finns"] },
  { tag: "poland", keywords: ["poland", "polish", "poles"] },
  { tag: "ukraine", keywords: ["ukraine", "ukrainian", "ukrainians"] },
  { tag: "russia", keywords: ["russia", "russian", "russians"] },
  { tag: "turkiye", keywords: ["turkiye", "turkey", "turkish"] },
  { tag: "greece", keywords: ["greece", "greek", "greeks"] },
  { tag: "romania", keywords: ["romania", "romanian", "romanians"] },
  {
    tag: "czechia",
    keywords: ["czechia", "czech republic", "czech", "czechs"],
  },
  { tag: "hungary", keywords: ["hungary", "hungarian", "hungarians"] },
  { tag: "ireland", keywords: ["ireland", "irish"] },
  { tag: "israel", keywords: ["israel", "israeli", "israelis"] },
  { tag: "palestine", keywords: ["palestine", "palestinian", "palestinians"] },
  { tag: "saudi arabia", keywords: ["saudi arabia", "saudi", "saudis"] },
  {
    tag: "united arab emirates",
    keywords: ["united arab emirates", "uae", "emirati"],
  },
  { tag: "qatar", keywords: ["qatar", "qatari", "qataris"] },
  { tag: "iran", keywords: ["iran", "iranian", "iranians"] },
  { tag: "iraq", keywords: ["iraq", "iraqi", "iraqis"] },
  { tag: "egypt", keywords: ["egypt", "egyptian", "egyptians"] },
  { tag: "morocco", keywords: ["morocco", "moroccan", "moroccans"] },
  { tag: "algeria", keywords: ["algeria", "algerian", "algerians"] },
  { tag: "tunisia", keywords: ["tunisia", "tunisian", "tunisians"] },
  { tag: "nigeria", keywords: ["nigeria", "nigerian", "nigerians"] },
  {
    tag: "south africa",
    keywords: ["south africa", "south african", "south africans"],
  },
  { tag: "kenya", keywords: ["kenya", "kenyan", "kenyans"] },
  { tag: "ethiopia", keywords: ["ethiopia", "ethiopian", "ethiopians"] },
  { tag: "ghana", keywords: ["ghana", "ghanaian", "ghanaians"] },
  { tag: "china", keywords: ["china", "chinese"] },
  { tag: "japan", keywords: ["japan", "japanese"] },
  { tag: "south korea", keywords: ["south korea", "korean", "south korean"] },
  { tag: "north korea", keywords: ["north korea", "north korean"] },
  { tag: "india", keywords: ["india", "indian", "indians"] },
  { tag: "pakistan", keywords: ["pakistan", "pakistani", "pakistanis"] },
  { tag: "bangladesh", keywords: ["bangladesh", "bangladeshi"] },
  { tag: "sri lanka", keywords: ["sri lanka", "sri lankan"] },
  { tag: "nepal", keywords: ["nepal", "nepali"] },
  { tag: "afghanistan", keywords: ["afghanistan", "afghan", "afghans"] },
  { tag: "indonesia", keywords: ["indonesia", "indonesian", "indonesians"] },
  { tag: "malaysia", keywords: ["malaysia", "malaysian", "malaysians"] },
  { tag: "singapore", keywords: ["singapore", "singaporean", "singaporeans"] },
  { tag: "thailand", keywords: ["thailand", "thai"] },
  { tag: "vietnam", keywords: ["vietnam", "vietnamese"] },
  {
    tag: "philippines",
    keywords: ["philippines", "philippine", "filipino", "filipinos"],
  },
  { tag: "australia", keywords: ["australia", "australian", "australians"] },
  { tag: "new zealand", keywords: ["new zealand", "new zealander", "kiwi"] },
];

export function normalizeAutoTagRules(inputRules) {
  if (!Array.isArray(inputRules)) {
    return [];
  }

  const mergedByTag = new Map();

  inputRules.forEach((rule) => {
    if (!rule || typeof rule !== "object") {
      return;
    }

    const tag = normalizeTag(String(rule.tag || ""));

    if (!tag) {
      return;
    }

    const keywordSet = mergedByTag.get(tag) || new Set();

    const keywordList = Array.isArray(rule.keywords)
      ? rule.keywords
      : typeof rule.keywords === "string"
        ? rule.keywords.split(",")
        : [];

    keywordList.forEach((keyword) => {
      const normalizedKeyword = normalizeKeyword(keyword);

      if (normalizedKeyword) {
        keywordSet.add(normalizedKeyword);
      }
    });

    if (keywordSet.size > 0) {
      mergedByTag.set(tag, keywordSet);
    }
  });

  return [...mergedByTag.entries()].map(([tag, keywords]) => ({
    tag,
    keywords: [...keywords].sort((left, right) => left.localeCompare(right)),
  }));
}

export function parseAutoTagRulesImport(rawText) {
  const parsed = JSON.parse(rawText);

  if (!Array.isArray(parsed)) {
    throw new Error("Rules import must be a JSON array of objects.");
  }

  const normalized = normalizeAutoTagRules(parsed);

  if (normalized.length === 0) {
    throw new Error("No valid rules were found in the imported JSON.");
  }

  return normalized;
}

export function getAutoTagSuggestionsForArticle(article, options) {
  if (!article || !Array.isArray(article.blocks)) {
    return [];
  }

  const articleText = article.blocks
    .map((block) => (block?.text || "").trim())
    .filter(Boolean)
    .join(" ");

  if (!articleText) {
    return [];
  }

  const rules = buildEffectiveRules(options || {});

  if (rules.length === 0) {
    return [];
  }

  const normalizedBody = ` ${normalizeKeyword(articleText)} `;

  if (!normalizedBody) {
    return [];
  }

  const matchedTags = [];

  rules.forEach((rule) => {
    const hasMatch = rule.keywords.some((keyword) => {
      if (!keyword) {
        return false;
      }

      return normalizedBody.includes(` ${keyword} `);
    });

    if (hasMatch) {
      matchedTags.push(rule.tag);
    }
  });

  return dedupeTags(matchedTags).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function getDefaultCountryRulesCount() {
  return DEFAULT_COUNTRY_RULES.length;
}

function buildEffectiveRules({
  autoTagEnabled,
  autoTagUseDefaultCountries,
  autoTagCustomRules,
}) {
  if (autoTagEnabled === false) {
    return [];
  }

  const mergedByTag = new Map();

  if (autoTagUseDefaultCountries !== false) {
    normalizeAutoTagRules(DEFAULT_COUNTRY_RULES).forEach((rule) => {
      mergedByTag.set(rule.tag, new Set(rule.keywords));
    });
  }

  normalizeAutoTagRules(autoTagCustomRules).forEach((rule) => {
    const set = mergedByTag.get(rule.tag) || new Set();

    rule.keywords.forEach((keyword) => set.add(keyword));
    mergedByTag.set(rule.tag, set);
  });

  return [...mergedByTag.entries()].map(([tag, keywords]) => ({
    tag,
    keywords: [...keywords],
  }));
}

function normalizeKeyword(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
