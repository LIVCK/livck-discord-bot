/**
 * Group a status page's subscriptions by what they need fetched.
 *
 * The API is asked once per distinct (apiToken, locale) pair rather than once per
 * subscription: the token decides WHAT the page returns, the locale decides in WHICH
 * language, and everything else is rendering. Ten channels watching the same page in German
 * cost one request, not ten.
 */
export const groupSubscriptions = (subscriptions = []) => {
    const groups = new Map();

    for (const subscription of subscriptions) {
        const token = subscription.apiToken || null;
        const locale = subscription.locale || 'de';
        const key = `${token || ''}::${locale}`;

        if (!groups.has(key)) {
            groups.set(key, { token, locale, subscriptions: [] });
        }
        groups.get(key).subscriptions.push(subscription);
    }

    return [...groups.values()];
};

export default groupSubscriptions;
