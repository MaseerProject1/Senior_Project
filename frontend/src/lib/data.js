const PATHS = {
  overview: "/data/overview.json",
  modelMetrics: "/data/model_metrics.json",
  forecastMetrics: "/data/forecast_metrics.json",
  contextualComparison: "/data/contextual_comparison.json",
  zonePressure: "/data/zone_pressure.json",
  topZones: "/data/top_zones.json",
  predictionsPreview: "/data/predictions_preview.json",
  datasetSummary: "/data/dataset_summary.json",
  featureDictionary: "/data/feature_dictionary.json",
  eventIntegrationSummary: "/data/event_integration_summary.json",
  scenarioDefaults: "/data/scenario_defaults.json",
  appConfig: "/data/app_config.json",
};

async function fetchJson(path, fallback) {
  try {
    const response = await fetch(path);
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

export async function loadDashboardData() {
  const [
    overview,
    modelMetrics,
    forecastMetrics,
    contextualComparison,
    zonePressure,
    topZones,
    predictionsPreview,
    datasetSummary,
    featureDictionary,
    eventIntegrationSummary,
    scenarioDefaults,
    appConfig,
  ] = await Promise.all([
    fetchJson(PATHS.overview, null),
    fetchJson(PATHS.modelMetrics, []),
    fetchJson(PATHS.forecastMetrics, []),
    fetchJson(PATHS.contextualComparison, []),
    fetchJson(PATHS.zonePressure, []),
    fetchJson(PATHS.topZones, []),
    fetchJson(PATHS.predictionsPreview, []),
    fetchJson(PATHS.datasetSummary, null),
    fetchJson(PATHS.featureDictionary, []),
    fetchJson(PATHS.eventIntegrationSummary, []),
    fetchJson(PATHS.scenarioDefaults, null),
    fetchJson(PATHS.appConfig, null),
  ]);

  return {
    overview,
    modelMetrics,
    forecastMetrics,
    contextualComparison,
    zonePressure,
    topZones,
    predictionsPreview,
    datasetSummary,
    featureDictionary,
    eventIntegrationSummary,
    scenarioDefaults,
    appConfig,
  };
}
