const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY;

/**
 * Search the web using the Brave Search API.
 * Get a free API key at https://brave.com/search/api/ (2000 searches/month free)
 *
 * @param {string} query - What to search for
 * @param {number} count - Number of results to return (max 10, default 5)
 */
export async function webSearch(query, count = 5) {
  if (!BRAVE_API_KEY) {
    return 'Web search is not configured. Add BRAVE_SEARCH_API_KEY to your .env file.\nGet a free key at https://brave.com/search/api/';
  }

  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', Math.min(count, 10).toString());
    url.searchParams.set('safesearch', 'moderate');

    const res = await fetch(url.toString(), {
      headers: {
        'X-Subscription-Token': BRAVE_API_KEY,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      return `Search API error: ${res.status} ${res.statusText}`;
    }

    const data = await res.json();
    const results = data.web?.results || [];

    if (results.length === 0) {
      return `No results found for "${query}"`;
    }

    const lines = results.map((r, i) =>
      `**${i + 1}. ${r.title}**\n${r.url}\n${r.description || '(no description)'}`
    );

    return `Search results for "${query}":\n\n${lines.join('\n\n')}`;
  } catch (err) {
    return `Error searching: ${err.message}`;
  }
}
