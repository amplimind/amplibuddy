// Words: what carries meaning in a text, for noticing repeats, ruts and interests.

const STOPWORDS = new Set(
  'a an and are at be before by can do does for from how in into is it its of on or that the their them this to under what when where which who why with'.split(' '),
);

/** The words that carry meaning: lowercase, no stopwords, plurals folded. */
export function contentWords(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)),
  );
}


/** Words that say nothing about a topic: the everyday of the town and of thinking out loud. */
export const EVERYDAY_WORDS = new Set(
  (
    'just want like feel feels felt something still time today morning evening afternoon night right next maybe really ' +
    'thing things been have that this with from about what into there here some more much first last again back know need ' +
    'think thinking going would could should them they their then than when where which while after over little good day ' +
    'days now new also make made done let get got even only well very own other same every because one two said says ' +
    'question questions answer answered answers read reading book books look looking walk wander stroll coffee food eat ' +
    'hungry sleep tired bench town home cafe café kiosk park library plaza internet studio workshop notice board note ' +
    'notes painting paint people watch watching company quiet settle settled moment finished finish started start found ' +
    'learned tried sitting staying came coming sure mind head stomach belly enough feeling while long little warm small ' +
    'place around always never ever since already thought thoughts actually energy hunger needs need quite kind real ' +
    'probably pretty lots enough perhaps whole part parts rest bit yet keep keeps kept'
  ).split(' '),
);

