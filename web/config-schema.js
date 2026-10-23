// Browser + main-process shared durable configuration contract.
(function (root, factory) {
    var schema = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = schema;
    if (root) root.AppConfigSchema = schema;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    var keys = [
        'fund_tracker_settings', 'fund_tracker_active_main_tab', 'fund_tracker_news_source',
        'fund_tracker_collapse_state', 'fund_tracker_sector_tab', 'fund_tracker_alert_settings',
        'fund_tracker_watch_alert_state', 'fund_tracker_custom_indices', 'fund_tracker_watchlist_cost',
        'fund_tracker_watchlist_remarks', 'fund_tracker_watchlist', 'fund_tracker_watchlist_tabs',
        'fund_tracker_active_watch_tab', 'fund_tracker_hot_rank_source', 'fund_tracker_limit_up_tab',
        'fund_tracker_ai_settings', 'fund_tracker_price_alerts',
        'fund_tracker_research_history',
        'fund_tracker_report_center',
    ];
    var jsonKeys = [
        'fund_tracker_settings', 'fund_tracker_collapse_state', 'fund_tracker_alert_settings',
        'fund_tracker_watch_alert_state', 'fund_tracker_custom_indices', 'fund_tracker_watchlist_cost',
        'fund_tracker_watchlist_remarks', 'fund_tracker_watchlist', 'fund_tracker_watchlist_tabs',
        'fund_tracker_ai_settings', 'fund_tracker_price_alerts',
        'fund_tracker_research_history',
        'fund_tracker_report_center',
    ];
    return { version: 2, keys: keys, jsonKeys: jsonKeys, nativeOwnedKeys: ['fund_tracker_report_center'] };
});
