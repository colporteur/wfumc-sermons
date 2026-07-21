// Link builder for the Colporteur reading-library app. One place to
// change if the app ever moves to a custom domain.

const COLPORTEUR_URL = 'https://colporteur.vercel.app';

/**
 * URL to Colporteur's /for-sermon page, pre-loaded with this sermon's
 * title, scripture, and theme — it gathers matching commentaries,
 * scripture-tagged extracts, and semantically related passages.
 */
export function colporteurSermonUrl(sermon) {
  const params = new URLSearchParams();
  if (sermon?.title) params.set('title', sermon.title);
  if (sermon?.scripture_reference) params.set('scripture', sermon.scripture_reference);
  if (sermon?.theme) params.set('theme', sermon.theme);
  return `${COLPORTEUR_URL}/for-sermon?${params.toString()}`;
}
