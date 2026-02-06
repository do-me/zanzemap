// CSS Imports for Vite to bundle
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-geocoder/dist/maplibre-gl-geocoder.css';
import '@fortawesome/fontawesome-free/css/all.min.css';
import './main.css';

// Library Imports
import maplibregl from 'maplibre-gl';
import MaplibreGeocoder from '@maplibre/maplibre-gl-geocoder';
import Plotly from 'plotly.js';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable'
import _ from 'underscore';
import { geojson } from 'flatgeobuf';

document.addEventListener('DOMContentLoaded', function () {
    const COLOR_SCALE = ['#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#253494', '#081d58'];
    const weekToMonth = { 15: 'Apr', 16: 'Apr', 17: 'Apr', 18: 'Apr', 19: 'May', 20: 'May', 21: 'May', 22: 'May', 23: 'May', 24: 'Jun', 25: 'Jun', 26: 'Jun', 27: 'Jun', 28: 'Jul', 29: 'Jul', 30: 'Jul', 31: 'Jul', 32: 'Aug', 33: 'Aug', 34: 'Aug', 35: 'Aug', 36: 'Sep', 37: 'Sep', 38: 'Sep', 39: 'Sep', 40: 'Oct', 41: 'Oct', 42: 'Oct', 43: 'Oct', 44: 'Nov', 45: 'Nov' };
    const NO_DATA_COLOR = 'rgba(128, 128, 128, 0.15)';
    const TRENDLINE = false;

    const map = new maplibregl.Map({
        container: 'map',
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [11.133, 45.957],
        zoom: 7,
        preserveDrawingBuffer: true
    });

    // --- STATE VARIABLES ---
    let selectedFeatures = [];
    let allBasemapLayerIds = { street: [], satellite: [] };
    let animationIntervalId = null;
    let featureIdCounter = 0;

    // --- CACHING VARIABLES ---
    const layerCaches = {
        mosquito: { features: new Map(), totalLoadedBounds: null, sourceId: 'mosquito-data', fgbPath: 'data/out/model_output_trentino.fgb', moveHandler: null },
        nuts: { features: new Map(), totalLoadedBounds: null, sourceId: 'nuts-regions', fgbPath: 'data/out/EU_NUTS3_01M.fgb', moveHandler: null },
        commune: { features: new Map(), totalLoadedBounds: null, sourceId: 'communes', fgbPath: 'data/out/IT_comuni.fgb', moveHandler: null },
        mosquito_2025: { features: new Map(), totalLoadedBounds: null, sourceId: 'mosquito-data-2025', fgbPath: 'data/out/model_output_trentino_2025.fgb', moveHandler: null },
        nuts_2025: { features: new Map(), totalLoadedBounds: null, sourceId: 'nuts-regions-2025', fgbPath: 'data/out/EU_NUTS3_01M_2025.fgb', moveHandler: null },
        commune_2025: { features: new Map(), totalLoadedBounds: null, sourceId: 'communes-2025', fgbPath: 'data/out/IT_comuni_2025.fgb', moveHandler: null },
    };

    // --- HELPER FUNCTIONS ---
    function getActivityLevel(percentage) {
        if (percentage > 75) return 'Very High';
        if (percentage >= 50) return 'High';
        if (percentage >= 25) return 'Moderate';
        return 'Low';
    }

    const _parseFeatureProperties = (feature) => {
        feature.id = featureIdCounter++;
        if (feature?.properties?.timeseries && typeof feature.properties.timeseries === 'string') {
            try {
                const jsonString = feature.properties.timeseries.replace(/'/g, '"');
                feature.properties.timeseries = JSON.parse(jsonString);
            } catch (e) {
                console.error("Could not parse timeseries property:", feature.properties.timeseries, e);
                feature.properties.timeseries = {};
            }
        } else if (!feature.properties.timeseries) {
            feature.properties.timeseries = {};
        }
        const values = Object.values(feature.properties.timeseries).filter(v => typeof v === 'number' && !isNaN(v));
        if (values.length > 0) {
            feature.properties.avg_value = values.reduce((a, b) => a + b, 0) / values.length;
        } else {
            feature.properties.avg_value = null;
        }
        return feature;
    };

    const getBoundingBox = (mapInstance) => {
        const bounds = mapInstance.getBounds();
        return { minX: bounds.getWest(), minY: bounds.getSouth(), maxX: bounds.getEast(), maxY: bounds.getNorth() };
    };

    function isBboxContained(innerBbox, outerBbox) {
        if (!innerBbox || !outerBbox) return false;
        return (innerBbox.minX >= outerBbox.minX && innerBbox.minY >= outerBbox.minY && innerBbox.maxX <= outerBbox.maxX && innerBbox.maxY <= outerBbox.maxY);
    }

    function unionBboxes(bbox1, bbox2) {
        if (!bbox1) return bbox2;
        if (!bbox2) return bbox1;
        return { minX: Math.min(bbox1.minX, bbox2.minX), minY: Math.min(bbox1.minY, bbox2.minY), maxX: Math.max(bbox1.maxX, bbox2.maxX), maxY: Math.max(bbox1.maxY, bbox2.maxY) };
    }

    // --- HIGH-PERFORMANCE STYLE UPDATE FUNCTION ---
    function updateFeatureStatesForWeek(week, layerType) {
        const cache = layerCaches[layerType];
        const sourceId = cache.sourceId;
        if (!cache || !map.getSource(sourceId) || !map.isSourceLoaded(sourceId)) {
            return;
        }
        cache.features.forEach(feature => {
            const value = feature.properties.timeseries?.[week];
            map.setFeatureState(
                { source: sourceId, id: feature.id },
                { value: (value !== undefined && value !== null) ? value : null }
            );
        });
    }

    // --- GENERIC DATA LOADING FUNCTION ---
    async function updateGenericData(layerType, fgbPath) {
        // Return a promise that resolves only when the data is fully loaded into the map
        return new Promise(async (resolve) => {
            const cache = layerCaches[layerType];
            const source = map.getSource(cache.sourceId);
            if (!source) return resolve();

            const currentBbox = getBoundingBox(map);
            // If the current view is already within the bounds of loaded data, resolve immediately.
            if (cache.totalLoadedBounds && isBboxContained(currentBbox, cache.totalLoadedBounds)) {
                return resolve();
            }

            const newFeatures = [];
            // Asynchronously deserialize features from the FlatGeobuf file for the current view.
            for await (const feature of geojson.deserialize(fgbPath, currentBbox)) {
                const name = feature.properties.name;
                // Skip if we already have this feature
                if (!name || cache.features.has(name)) continue;

                // In limited version, only include features where study_area_extent_trentino is true
                const isLimitedVersion = window.APP_CONFIG?.isLimitedVersion === true;
                const isForecastLayer = layerType.includes('_2025');
                if (isLimitedVersion && isForecastLayer && feature.properties.study_area_extent_trentino !== true) {
                    // Parse timeseries if it's a string
                    if (typeof feature.properties.timeseries === 'string') {
                        try {
                            feature.properties.timeseries = JSON.parse(feature.properties.timeseries.replace(/'/g, '"'));
                        } catch (e) {
                            console.error('Error parsing timeseries:', e);
                            feature.properties.timeseries = {};
                        }
                    }

                    // Set all timeseries values to null for features outside the study area
                    if (feature.properties.timeseries && typeof feature.properties.timeseries === 'object') {
                        for (const week in feature.properties.timeseries) {
                            feature.properties.timeseries[week] = null;
                        }
                    }
                }

                const parsedFeature = _parseFeatureProperties(feature);
                cache.features.set(name, parsedFeature);
                newFeatures.push(parsedFeature);
            }

            // Only proceed if new features were actually found.
            if (newFeatures.length > 0) {
                // Define a one-time event listener for when the source data has been processed by the map.
                const onSourceData = (e) => {
                    if (e.sourceId === cache.sourceId && e.isSourceLoaded) {
                        map.off('sourcedata', onSourceData); // Clean up the listener to prevent memory leaks.
                        resolve(); // Now, we resolve the promise, signaling that styling can proceed.
                    }
                };
                map.on('sourcedata', onSourceData);

                // Add the new features to the source and trigger the update.
                const sourceData = source._data;
                sourceData.features.push(...newFeatures);
                source.setData(sourceData);
            } else {
                // If no new features were found, resolve immediately.
                resolve();
            }
            // Update the cache with the new bounding box of loaded data.
            cache.totalLoadedBounds = unionBboxes(cache.totalLoadedBounds, currentBbox);
        });
    }

    async function loadAllBasemaps() {
        const streetStyle = map.getStyle();
        allBasemapLayerIds.street = streetStyle.layers.map(l => l.id);
        map.addSource('satellite-source', { type: 'raster', tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256 });
        map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite-source', layout: { visibility: 'none' } });
        allBasemapLayerIds.satellite.push('satellite-layer');
    }

    function addOverlayLayers() {
        // Add sources for all defined layers in the cache
        Object.values(layerCaches).forEach(cache => {
            map.addSource(cache.sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        });
        map.addSource('highlight-layer', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

        const probabilityPaint = [
            'case',
            ['==', ['feature-state', 'value'], null], NO_DATA_COLOR,
            [
                'interpolate', ['linear'], ['feature-state', 'value'],
                0.0, COLOR_SCALE[0], 0.125, COLOR_SCALE[1], 0.25, COLOR_SCALE[2],
                0.375, COLOR_SCALE[3], 0.5, COLOR_SCALE[4], 0.625, COLOR_SCALE[5],
                0.75, COLOR_SCALE[6], 0.875, COLOR_SCALE[7], 1.0, COLOR_SCALE[8]
            ]
        ];

        // Add layers for each data type
        map.addLayer({ id: 'mosquito-layer', type: 'fill', source: layerCaches.mosquito.sourceId, layout: { visibility: 'none' }, paint: { 'fill-color': probabilityPaint, 'fill-opacity': 0.75, 'fill-outline-color': 'rgba(0,0,0,0.2)' } });
        map.addLayer({ id: 'nuts-layer', type: 'fill', source: layerCaches.nuts.sourceId, layout: { visibility: 'none' }, paint: { 'fill-color': probabilityPaint, 'fill-opacity': 0.75, 'fill-outline-color': '#0c2461' } });
        map.addLayer({ id: 'commune-layer', type: 'fill', source: layerCaches.commune.sourceId, layout: { visibility: 'none' }, paint: { 'fill-color': probabilityPaint, 'fill-opacity': 0.75, 'fill-outline-color': '#8e44ad' } });

        // Add new 2025 layers
        map.addLayer({ id: 'mosquito_2025-layer', type: 'fill', source: layerCaches.mosquito_2025.sourceId, layout: { visibility: 'none' }, paint: { 'fill-color': probabilityPaint, 'fill-opacity': 0.75, 'fill-outline-color': 'rgba(0,0,0,0.2)' } });
        map.addLayer({ id: 'nuts_2025-layer', type: 'fill', source: layerCaches.nuts_2025.sourceId, layout: { visibility: 'none' }, paint: { 'fill-color': probabilityPaint, 'fill-opacity': 0.75, 'fill-outline-color': '#0c2461' } });
        map.addLayer({ id: 'commune_2025-layer', type: 'fill', source: layerCaches.commune_2025.sourceId, layout: { visibility: 'none' }, paint: { 'fill-color': probabilityPaint, 'fill-opacity': 0.75, 'fill-outline-color': '#8e44ad' } });

        map.addLayer({ id: 'highlight-polygons', type: 'line', source: 'highlight-layer', paint: { 'line-color': '#FFA500', 'line-width': 3.5, 'line-opacity': 1 } });
    }

    // --- VIEW UPDATE FUNCTIONS ---
    function updateAllViews() {
        updateSelection();
        updateChart();
        updateRegionData();
        updateLegend();
    }

    function updateLegend() {
        const legendContainer = document.getElementById('map-legend-content');
        if (!legendContainer) return; // Guard against missing element

        const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
        const is2025Forecast = activeLayerType.includes('_2025');
        const dataTypeText = is2025Forecast ? '2025 Forecast' : '2020-2024 Average';

        const legendTitle = document.querySelector('#legend-group button span');
        if (legendTitle) {
            legendTitle.innerHTML = '<i class="fas fa-map-marked-alt"></i> Activity Index (' + dataTypeText + ')';
        }

        legendContainer.innerHTML = '';
        [COLOR_SCALE[8], COLOR_SCALE[6], COLOR_SCALE[4], COLOR_SCALE[2]].forEach((color, index) => {
            const levelText = ['Very High (>75%)', 'High (50-75%)', 'Moderate (25-50%)', 'Low (<25%)'][index];
            legendContainer.innerHTML += `<div class="flex items-center"><div class="legend-color" style="background-color: ${color};"></div><span class="ml-2 text-sm">${levelText}</span></div>`;
        });
    }

    function updateSelection() {
        if (map.getSource('highlight-layer')) map.getSource('highlight-layer').setData({ type: 'FeatureCollection', features: selectedFeatures });
    }

    function getLevel(value) {
        if (value >= 0.75) return { symbol: 'very high', color: COLOR_SCALE[8] };
        if (value >= 0.50) return { symbol: 'high', color: COLOR_SCALE[6] };
        if (value >= 0.25) return { symbol: 'moderate', color: COLOR_SCALE[4] };
        return { symbol: 'low', color: COLOR_SCALE[2] };
    }

    function calculateAggregateData(currentWeek) {
        const weeks = Array.from({ length: 31 }, (_, i) => i + 15);
        const weeklyAverages = {};
        let allValues = [];
        const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
        const features = Array.from(layerCaches[activeLayerType].features.values());

        if (features.length === 0) {
            weeks.forEach(week => weeklyAverages[week] = null);
            return { current: null, peak: null, average: null, weeklyAverages };
        }
        weeks.forEach(week => {
            const weekValues = features.map(f => f.properties.timeseries[week])
                .filter(v => v !== undefined && v !== null && typeof v === 'number');
            weeklyAverages[week] = weekValues.length > 0 ? weekValues.reduce((a, b) => a + b, 0) / weekValues.length : null;
            allValues.push(...weekValues);
        });
        const peak = allValues.length > 0 ? Math.max(...allValues) : null;
        const average = allValues.length > 0 ? allValues.reduce((a, b) => a + b, 0) / allValues.length : null;
        const current = weeklyAverages[currentWeek] !== undefined ? weeklyAverages[currentWeek] : null;
        return { current, peak, average, weeklyAverages };
    }

    function updateRegionData() {
        const regionDataEl = document.getElementById('region-data');
        if (!regionDataEl) return; // Guard against missing element

        const currentWeek = document.getElementById('week-slider').value;
        let props, timeseries, title;

        if (selectedFeatures.length === 0) {
            const activeLayerLabel = document.querySelector('input[name="thematic-layer"]:checked + label').textContent.trim();
            const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
            const is2025Forecast = activeLayerType.includes('_2025');
            const dataTypeText = is2025Forecast ? '2025 Forecast' : '2020-2024 Average';
            title = `${activeLayerLabel} (${dataTypeText})`;
            const aggregate = calculateAggregateData(currentWeek);
            props = { current: aggregate.current, peak: aggregate.peak, average: aggregate.average };
            timeseries = aggregate.weeklyAverages;
        } else {
            const feature = selectedFeatures[0];
            const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
            const is2025Forecast = activeLayerType.includes('_2025');
            const dataTypeText = is2025Forecast ? '2025 Forecast' : '2020-2024 Average';
            title = `${feature.properties.name || feature.properties.region || 'Unnamed Region'} (${dataTypeText})`;
            const allValues = Object.values(feature.properties.timeseries || {}).filter(v => typeof v === 'number' && v !== null && v !== undefined);
            const currentValue = feature.properties.timeseries && feature.properties.timeseries[currentWeek];
            const hasCurrent = currentValue !== undefined && currentValue !== null;

            props = {
                current: hasCurrent ? currentValue : null,
                peak: allValues.length > 0 ? Math.max(...allValues) : null,
                average: allValues.length > 0 ? allValues.reduce((a, b) => a + b, 0) / allValues.length : null
            };
            timeseries = feature.properties.timeseries;
        }

        let baseLayerData = null;
        const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
        const is2025Forecast = activeLayerType.includes('_2025');

        if (is2025Forecast) {
            const baseLayerType = activeLayerType.replace('_2025', '');
            const baseLayerFeatures = Array.from(layerCaches[baseLayerType].features.values());

            if (baseLayerFeatures.length > 0) {
                if (selectedFeatures.length > 0) {
                    const selectedFeatureName = selectedFeatures[0].properties.name || selectedFeatures[0].properties.region;
                    const baseFeature = baseLayerFeatures.find(f => f.properties.name === selectedFeatureName || f.properties.region === selectedFeatureName);
                    if (baseFeature && baseFeature.properties.timeseries) {
                        baseLayerData = baseFeature.properties.timeseries;
                    }
                } else {
                    const weeks = Array.from({ length: 31 }, (_, i) => i + 15);
                    baseLayerData = {};
                    weeks.forEach(week => {
                        const weekValues = baseLayerFeatures.map(f => f.properties.timeseries && f.properties.timeseries[week]).filter(v => v !== undefined && v !== null && typeof v === 'number');
                        baseLayerData[week] = weekValues.length > 0 ? weekValues.reduce((a, b) => a + b, 0) / weekValues.length : null;
                    });
                }
            }
        }

        const weeks = Array.from({ length: 31 }, (_, i) => i + 15);
        const tableHeaders = baseLayerData
            ? '<th class="p-1 text-center">Week</th><th class="p-1 text-center">2025 Forecast</th><th class="p-1 text-center">2020-2024 Avg</th><th class="p-1 text-center">Level</th>'
            : '<th class="p-1 text-center">Week</th><th class="p-1 text-center">Activity Index</th><th class="p-1 text-center">Level</th>';

        regionDataEl.innerHTML = `
            <div class="p-4 bg-blue-50 dark:bg-gray-700/50 rounded-lg">
                <h4 class="font-bold text-lg mb-3 text-primary dark:text-blue-300">${title}</h4>
                <div class="grid grid-cols-3 gap-2 mb-4">
                    <div class="bg-white dark:bg-gray-800 p-2 rounded text-center"><div class="text-xs text-gray-500 dark:text-gray-400">Current</div><div class="font-bold">${props.current !== null ? (props.current * 100).toFixed(1) + '%' : '-'}</div></div>
                    <div class="bg-white dark:bg-gray-800 p-2 rounded text-center"><div class="text-xs text-gray-500 dark:text-gray-400">Peak</div><div class="font-bold">${props.peak !== null ? (props.peak * 100).toFixed(1) + '%' : '-'}</div></div>
                    <div class="bg-white dark:bg-gray-800 p-2 rounded text-center"><div class="text-xs text-gray-500 dark:text-gray-400">Average</div><div class="font-bold">${props.average !== null ? (props.average * 100).toFixed(1) + '%' : '-'}</div></div>
                </div>
                <div class="overflow-y-auto"><table class="w-full text-sm">
                    <thead><tr class="dark:bg-gray-900/50 sticky top-0">${tableHeaders}</tr></thead>
                    <tbody>${weeks.map(week => {
            const rawValue = timeseries && timeseries[week];
            const hasValue = rawValue !== undefined && rawValue !== null;
            const value = hasValue ? rawValue : 0;
            const level = hasValue ? getLevel(value) : { symbol: '-', color: '#000000' };
            const displayValue = hasValue ? `${(value * 100).toFixed(1)}%` : '-';
            const baseValue = baseLayerData && baseLayerData[week];
            const baseDisplayValue = baseValue !== undefined && baseValue !== null ? `${(baseValue * 100).toFixed(1)}%` : '-';

            if (baseLayerData) {
                return `<tr class="${week == currentWeek ? 'bg-blue-100 dark:bg-gray-700' : ''}">
                                <td class="p-1 text-center">${week} (${weekToMonth[week]})</td>
                                <td class="p-1 font-bold text-center">${displayValue}</td>
                                <td class="p-1 font-bold text-center text-gray-600">${baseDisplayValue}</td>
                                <td class="p-1 font-bold text-center" style="color: ${level.color};">${level.symbol}</td>
                            </tr>`;
            } else {
                return `<tr class="${week == currentWeek ? 'bg-blue-100 dark:bg-gray-700' : ''}">
                                <td class="p-1 text-center">${week} (${weekToMonth[week]})</td>
                                <td class="p-1 font-bold text-center">${displayValue}</td>
                                <td class="p-1 font-bold text-center" style="color: ${level.color};">${level.symbol}</td>
                            </tr>`;
            }
        }).join('')}</tbody>
                </table></div>
            </div>`;
    }

    function calculateLinearRegression(data) {
        const n = data.x.length;
        if (n < 2) return { trendline: [] };
        const sumX = data.x.reduce((a, b) => a + b, 0);
        const sumY = data.y.reduce((a, b) => a + b, 0);
        const sumXY = data.x.map((x, i) => x * data.y[i]).reduce((a, b) => a + b, 0);
        const sumX2 = data.x.map(x => x * x).reduce((a, b) => a + b, 0);
        const denominator = (n * sumX2 - sumX * sumX);
        if (denominator === 0) return { trendline: [] };
        const slope = (n * sumXY - sumX * sumY) / denominator;
        const intercept = (sumY - slope * sumX) / n;
        const trendline = data.x.map(x => slope * x + intercept);
        return { trendline };
    }

    function updateChart() {
        const chartEl = document.getElementById('timeseries-chart');
        if (!chartEl) return; // Guard against missing element

        const currentWeek = document.getElementById('week-slider').value;
        const weeks = Array.from({ length: 31 }, (_, i) => i + 15);
        let traces = [];
        let chartTitle;
        let mainData;

        const { weeklyAverages } = calculateAggregateData(currentWeek);
        const overallAvgValues = weeks.map(w => weeklyAverages[w] || 0);

        if (selectedFeatures.length > 0) {
            const props = selectedFeatures[0].properties;
            const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
            const is2025Forecast = activeLayerType.includes('_2025');
            const dataTypeText = is2025Forecast ? '2025 Forecast' : '2020-2024 Average';
            chartTitle = `Activity Index: ${props.name || props.region || 'Selected Region'} (${dataTypeText})`;

            const selectedData = weeks.map(week => ({
                week: week,
                value: props.timeseries && props.timeseries[week] !== undefined && props.timeseries[week] !== null ? props.timeseries[week] : null
            })).filter(d => d.value !== null);

            mainData = {
                x: selectedData.map(d => d.week),
                y: selectedData.map(d => d.value)
            };

            traces.push({
                x: mainData.x,
                y: mainData.y.map(v => v * 100),
                type: 'scatter', mode: 'lines+markers', name: props.name || 'Selected',
                line: { color: '#1e3799', width: 2.5 },
                marker: { size: 6, color: '#1e3799' }
            });

            if (is2025Forecast) {
                const baseLayerType = activeLayerType.replace('_2025', '');
                const baseLayerFeatures = Array.from(layerCaches[baseLayerType].features.values());
                if (baseLayerFeatures.length > 0) {
                    const selectedFeatureName = props.name || props.region;
                    const baseFeature = baseLayerFeatures.find(f => f.properties.name === selectedFeatureName || f.properties.region === selectedFeatureName);
                    if (baseFeature && baseFeature.properties.timeseries) {
                        const backgroundData = weeks.map(week => ({
                            week: week,
                            value: baseFeature.properties.timeseries[week] !== undefined && baseFeature.properties.timeseries[week] !== null ? baseFeature.properties.timeseries[week] : null
                        })).filter(d => d.value !== null);
                        if (backgroundData.length > 0) {
                            traces.push({
                                x: backgroundData.map(d => d.week),
                                y: backgroundData.map(d => d.value * 100),
                                type: 'scatter', mode: 'lines', name: '2020-2024 Average',
                                line: { color: '#7fcdbb', width: 2, dash: 'dot' }
                            });
                        }
                    }
                }
            } else {
                const avgData = weeks.map(week => ({
                    week: week,
                    value: weeklyAverages[week] !== undefined && weeklyAverages[week] !== null && weeklyAverages[week] > 0 ? weeklyAverages[week] : null
                })).filter(d => d.value !== null);
                traces.push({
                    x: avgData.map(d => d.week),
                    y: avgData.map(d => d.value * 100),
                    type: 'scatter', mode: 'lines', name: 'Layer Average',
                    line: { color: '#7fcdbb', width: 2, dash: 'dot' }
                });
            }
        } else {
            const activeLayerLabel = document.querySelector('input[name="thematic-layer"]:checked + label').textContent.trim();
            const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
            const is2025Forecast = activeLayerType.includes('_2025');
            const dataTypeText = is2025Forecast ? '2025 Forecast' : '2020-2024 Average';
            chartTitle = `Activity Index: ${activeLayerLabel} (${dataTypeText})`;

            const avgData = weeks.map(week => ({
                week: week,
                value: weeklyAverages[week] !== undefined && weeklyAverages[week] !== null && weeklyAverages[week] > 0 ? weeklyAverages[week] : null
            })).filter(d => d.value !== null);

            mainData = { x: avgData.map(d => d.week), y: avgData.map(d => d.value) };

            traces.push({
                x: mainData.x,
                y: mainData.y.map(v => v * 100),
                type: 'scatter', mode: 'lines+markers', name: 'Average',
                line: { color: '#1e3799', width: 2.5 },
                marker: { size: 6, color: '#1e3799' }
            });
        }

        if (TRENDLINE && mainData && mainData.y.some(v => v > 0)) {
            const { trendline } = calculateLinearRegression(mainData);
            if (trendline.length > 0) {
                traces.push({
                    x: mainData.x,
                    y: trendline.map(v => v * 100),
                    type: 'scatter', mode: 'lines', name: 'Trend',
                    line: { color: '#d73027', width: 2, dash: 'dash' }
                });
            }
        }

        const chartTitleEl = document.getElementById('chart-title');
        if (chartTitleEl) chartTitleEl.innerHTML = `<i class="fas fa-chart-line mr-2"></i> ${chartTitle}`;

        const layout = {
            template: document.documentElement.classList.contains('dark') ? 'plotly_dark' : 'plotly_white',
            xaxis: { range: [14.5, 45.5], tickvals: weeks, title: { text: 'Calendar Week', standoff: 20 } },
            yaxis: { title: { text: 'Activity Index', standoff: 10 }, range: [0, 102], ticksuffix: '%' },
            hovermode: 'x unified', showlegend: true, legend: { orientation: 'h', y: -0.3, yanchor: 'top', x: 0.5, xanchor: 'center' },
            margin: { t: 20, b: 60, l: 50, r: 20 },
            shapes: [{ type: 'line', x0: currentWeek, x1: currentWeek, y0: 0, y1: 1, yref: 'paper', line: { color: 'red', width: 1.5, dash: 'dash' } }]
        };
        Plotly.newPlot(chartEl, traces, layout, { responsive: true, displayModeBar: false });
    }

    // --- INTERACTION HANDLERS ---
    function handleFeatureClick(e) {
        e.preventDefault();
        const featureId = e.features[0].id;
        const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
        const cache = layerCaches[activeLayerType];

        selectedFeatures = [];
        for (const feature of cache.features.values()) {
            if (feature.id === featureId) {
                selectedFeatures = [feature];
                break;
            }
        }
        updateAllViews();
    }

    async function toggleThematicLayer(layerType) {
        try {
            console.log(`Toggling to layer: ${layerType}`);
            const cache = layerCaches[layerType];
            await updateGenericData(layerType, cache.fgbPath);
            console.log(`[OK] Geometry for "${layerType}" is loaded.`);

            if (layerType.includes('_2025')) {
                const baseLayerType = layerType.replace('_2025', '');
                const baseCache = layerCaches[baseLayerType];
                if (baseCache && baseCache.features.size === 0) {
                    await updateGenericData(baseLayerType, baseCache.fgbPath);
                    console.log(`[OK] Base layer "${baseLayerType}" loaded for comparison.`);
                }
            }

            Object.keys(layerCaches).forEach(key => {
                map.setLayoutProperty(`${key}-layer`, 'visibility', key === layerType ? 'visible' : 'none');
            });
            console.log(`[OK] Visibility set for "${layerType}".`);

            const currentWeek = document.getElementById('week-slider').value;
            updateFeatureStatesForWeek(currentWeek, layerType);
            console.log(`[OK] Thematic data for week ${currentWeek} applied to "${layerType}".`);

            Object.values(layerCaches).forEach(otherCache => {
                if (otherCache.moveHandler) {
                    map.off('moveend', otherCache.moveHandler);
                    otherCache.moveHandler = null;
                }
            });

            cache.moveHandler = _.throttle(() => updateGenericData(layerType, cache.fgbPath), 500);
            map.on('moveend', cache.moveHandler);

            selectedFeatures = [];
            updateAllViews();
        } catch (error) {
            console.error(`Error during toggleThematicLayer for "${layerType}":`, error);
        }
    }

    async function loadImageAsBase64(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const dataURL = canvas.toDataURL('image/png');
                resolve({ src: dataURL, width: img.width, height: img.height });
            };
            img.onerror = (e) => reject(new Error(`Failed to load image: ${url}`));
            img.src = url;
        });
    }

    function captureMapImage(mapInstance, targetWidth, targetHeight) {
        return new Promise((resolve, reject) => {
            const container = mapInstance.getContainer();
            const originalStyle = { width: container.style.width, height: container.style.height, position: container.style.position, top: container.style.top, left: container.style.left, zIndex: container.style.zIndex };
            const targetAspectRatio = targetHeight / targetWidth;
            const printWidth = 1200, printHeight = printWidth * targetAspectRatio;

            Object.assign(container.style, { position: 'absolute', top: '-9999px', left: '-9999px', width: `${printWidth}px`, height: `${printHeight}px` });

            try {
                mapInstance.resize();
                mapInstance.once('idle', () => {
                    try {
                        resolve(mapInstance.getCanvas().toDataURL('image/jpeg', 0.85));
                    } catch (e) { reject(e); }
                    finally {
                        Object.assign(container.style, originalStyle);
                        mapInstance.resize();
                    }
                });
            } catch (err) {
                Object.assign(container.style, originalStyle);
                mapInstance.resize();
                reject(err);
            }
        });
    }

    async function generateReport() {
        const downloadButton = document.getElementById('downloadButton');
        if (!downloadButton) return;

        const loading = document.createElement('div');
        loading.className = 'fixed inset-0 bg-black bg-opacity-70 flex flex-col items-center justify-center z-50 text-white';
        loading.innerHTML = `<div class="spinner"></div><div class="mt-4 text-xl">Generating report...</div>`;
        document.body.appendChild(loading);

        try {
            const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true });
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const margin = 15;
            let yPos;

            const [vrtLogoData, femLogoData, iftamedEuLogoData, c3aLogoData, zanzeLogoData, geoRocksLogoData] = await Promise.all([
                loadImageAsBase64('logos/fondazione_vrt.png'), loadImageAsBase64('logos/fondazione_edmund_mach.jpg'),
                loadImageAsBase64('logos/iftamed_eu.jpg'), loadImageAsBase64('logos/c3a.png'),
                loadImageAsBase64('logos/logo-zanzemap-1024x320.png'), loadImageAsBase64('logos/geo_rocks_logo.jpg')
            ]);
            const logoUrls = { vrt: 'https://www.fondazionevrt.it/', fem: 'https://www.fmach.it/', iftamedEu: 'https://cri.fmach.it/Ricerca/Progetti/IFTAMED-Influence-of-Fluctuating-Temperatures-on-Aedes-invasive-Mosquitoes-Ecophysiology-and-Distribution#', c3a: 'https://www.c3a.org/', zanze: 'https://zanzemap.it/', geoRocks: 'https://geo.rocks/' };

            yPos = 15;
            const targetLogoHeight = 13.5;
            const headerLogos = [{ data: vrtLogoData, type: 'PNG', url: logoUrls.vrt }, { data: femLogoData, type: 'JPG', url: logoUrls.fem }, { data: iftamedEuLogoData, type: 'JPG', url: logoUrls.iftamedEu }, { data: c3aLogoData, type: 'PNG', url: logoUrls.c3a }, { data: geoRocksLogoData, type: 'JPG', url: logoUrls.geoRocks }];
            const scaledLogos = headerLogos.map(logo => ({ src: logo.data.src, type: logo.type, width: targetLogoHeight * (logo.data.width / logo.data.height), height: targetLogoHeight, url: logo.url }));
            const totalLogosWidth = scaledLogos.reduce((sum, logo) => sum + logo.width, 0);
            const gap = (pdfWidth - (2 * margin) - totalLogosWidth) / (headerLogos.length - 1);
            let currentX = margin;
            scaledLogos.forEach(logo => {
                pdf.addImage(logo.src, logo.type, currentX, yPos, logo.width, logo.height);
                pdf.link(currentX, yPos, logo.width, logo.height, { url: logo.url });
                currentX += logo.width + gap;
            });

            yPos = 45;
            const zanzeWidth = 70, zanzeHeight = zanzeWidth / (zanzeLogoData.width / zanzeLogoData.height), zanzeX = pdfWidth / 2 - zanzeWidth / 2;
            pdf.addImage(zanzeLogoData.src, 'PNG', zanzeX, yPos, zanzeWidth, zanzeHeight);
            pdf.link(zanzeX, yPos, zanzeWidth, zanzeHeight, { url: logoUrls.zanze });
            yPos += zanzeHeight + 12;

            pdf.setFontSize(24).setFont('helvetica', 'bold').text('ZanZemap Report', pdfWidth / 2, yPos, { align: 'center' });
            yPos += 10;

            const selectedAdminUnit = selectedFeatures.length > 0 ? (selectedFeatures[0].properties.name || 'N/A') : 'All Regions (Average)';
            pdf.setFontSize(14).setFont('helvetica', 'normal').text(`Report for ${selectedAdminUnit} | Generated on: ${new Date().toLocaleDateString()}`, pdfWidth / 2, yPos, { align: 'center' });
            yPos += 15;

            const selectedSpatialExtent = document.querySelector('input[name="thematic-layer"]:checked + label')?.textContent.trim();
            const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
            const dataTypeText = activeLayerType.includes('_2025') ? '2025 Forecast' : '2020-2024 Average';
            const details = { "Selected spatial extent:": selectedSpatialExtent, "Selected administrative unit:": selectedAdminUnit, "Species:": "Aedes albopictus", "Model:": "albo_alpine_ML_v0.01", "Dataset:": "VectAbundance v1.5", "Output type:": `Activity Index (${dataTypeText})` };

            pdf.setFontSize(11);
            Object.entries(details).forEach(([key, value]) => {
                pdf.setFont('helvetica', 'bold').text(key, margin + 20, yPos);
                pdf.setFont('helvetica', 'normal').text(value, margin + 75, yPos);
                yPos += 7;
            });
            yPos += 8;

            const mapImgWidth = pdfWidth - (margin * 2);
            const currentWeek = document.getElementById('week-slider').value;
            const mapDescText = `The map above displays Activity Index for the Aedes albopictus species for week ${currentWeek} using ${dataTypeText} data. The model was trained on VectAbundance dataset version 1.5 on the aggregated ovitraps located in the following Alpine area: ${selectedAdminUnit}.`;
            const splitMapText = pdf.splitTextToSize(mapDescText, mapImgWidth);
            const mapDescHeight = (splitMapText.length * 4) + 4;
            let mapImgHeight = Math.min(mapImgWidth * (3 / 4), pdf.internal.pageSize.getHeight() - yPos - margin - mapDescHeight);

            const mapImage = await captureMapImage(map, mapImgWidth, mapImgHeight);
            pdf.addImage(mapImage, 'PNG', margin, yPos, mapImgWidth, mapImgHeight);

            const hexToRgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
            const legendWidth = 38, legendX = margin + mapImgWidth - legendWidth - 2, legendY = yPos + 2, legendPadding = 3, titleHeight = 7, colorBoxSize = 4;
            const legendData = [{ color: COLOR_SCALE[8], text: 'Very High (>75%)' }, { color: COLOR_SCALE[6], text: 'High (50-75%)' }, { color: COLOR_SCALE[4], text: 'Moderate (25-50%)' }, { color: COLOR_SCALE[2], text: 'Low (<25%)' }];
            const legendHeight = (legendData.length * 6) + titleHeight + (legendPadding * 2);

            // This removes the failing setGState calls
            pdf.setFillColor(255, 255, 255);
            pdf.roundedRect(legendX, legendY, legendWidth, legendHeight, 2, 2, 'F');

            pdf.setDrawColor(120, 120, 120);
            pdf.roundedRect(legendX, legendY, legendWidth, legendHeight, 2, 2, 'S');

            let currentLegendY = legendY + legendPadding + 3;
            pdf.setFontSize(10).setFont('helvetica', 'bold').setTextColor(12, 36, 97).text(`Activity Index`, legendX + legendPadding, currentLegendY, { align: 'left' });
            currentLegendY += titleHeight - 2;
            pdf.setFontSize(8).setFont('helvetica', 'normal');
            legendData.forEach(item => {
                const rgb = hexToRgb(item.color);
                pdf.setFillColor(rgb.r, rgb.g, rgb.b).rect(legendX + legendPadding, currentLegendY - 1, colorBoxSize, colorBoxSize, 'F');
                pdf.setTextColor(0, 0, 0).text(item.text, legendX + legendPadding + colorBoxSize + 2, currentLegendY + (colorBoxSize / 2) - 1, { baseline: 'middle' });
                currentLegendY += 6;
            });

            yPos += mapImgHeight + 8;
            pdf.setFontSize(10).setTextColor(80, 80, 80).text(splitMapText, margin, yPos);

            const chartEl = document.getElementById('timeseries-chart');
            if (chartEl) {
                pdf.addPage();
                yPos = margin + 10;
                const chartImage = await Plotly.toImage(chartEl, { format: 'jpeg', width: 1000, height: 450, jpeg_quality: 100 });
                const chartImgWidth = pdfWidth - (margin * 2), chartImgHeight = (450 / 1000) * chartImgWidth;
                pdf.addImage(chartImage, 'JPEG', margin, yPos, chartImgWidth, chartImgHeight);
                yPos += chartImgHeight + 10;
                const chartDescText = `The temporal plot displays, for ${selectedAdminUnit}, the average prediction over years 2018-2023. The prediction for week ${currentWeek} is highlighted with a vertical dashed line. The detailed weekly data is provided in the following table.`;
                pdf.setFontSize(11).setTextColor(0, 0, 0).text(pdf.splitTextToSize(chartDescText, pdfWidth - (margin * 2)), margin, yPos);
            }

            const regionDataEl = document.getElementById('region-data');
            if (regionDataEl) {
                pdf.addPage();
                yPos = margin + 5;
                let tableData, baseLayerDataPDF = null;
                const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
                const is2025Forecast = activeLayerType.includes('_2025');

                if (selectedFeatures.length > 0) {
                    tableData = selectedFeatures[0].properties.timeseries;
                    if (is2025Forecast) {
                        const baseLayerType = activeLayerType.replace('_2025', '');
                        const baseFeature = Array.from(layerCaches[baseLayerType].features.values()).find(f => f.properties.name === (selectedFeatures[0].properties.name || selectedFeatures[0].properties.region));
                        if (baseFeature) baseLayerDataPDF = baseFeature.properties.timeseries;
                    }
                } else {
                    tableData = calculateAggregateData(currentWeek).weeklyAverages;
                    if (is2025Forecast) {
                        const baseLayerType = activeLayerType.replace('_2025', '');
                        const baseFeatures = Array.from(layerCaches[baseLayerType].features.values());
                        if (baseFeatures.length > 0) {
                            baseLayerDataPDF = {};
                            Array.from({ length: 31 }, (_, i) => i + 15).forEach(week => {
                                const weekValues = baseFeatures.map(f => f.properties.timeseries?.[week]).filter(v => typeof v === 'number');
                                baseLayerDataPDF[week] = weekValues.length > 0 ? weekValues.reduce((a, b) => a + b, 0) / weekValues.length : null;
                            });
                        }
                    }
                }
                const head = baseLayerDataPDF ? [['Week', 'Month', '2025 Forecast [%]', '2020-2024 Avg [%]', 'Level']] : [['Week', 'Month', 'Activity Index [%]', 'Level']];
                const body = Array.from({ length: 31 }, (_, i) => i + 15).map(week => {
                    const value = tableData?.[week];
                    const baseValue = baseLayerDataPDF?.[week];
                    const displayValue = value !== undefined && value !== null ? (value * 100).toFixed(1) : '-';
                    const level = value !== undefined && value !== null ? getActivityLevel(value * 100) : '-';
                    if (baseLayerDataPDF) {
                        const baseDisplayValue = baseValue !== undefined && baseValue !== null ? (baseValue * 100).toFixed(1) : '-';
                        return [week.toString(), weekToMonth[week] || '', displayValue, baseDisplayValue, level];
                    }
                    return [week.toString(), weekToMonth[week] || '', displayValue, level];
                });
                autoTable(pdf, {
                    head, body, startY: yPos, headStyles: { fillColor: [12, 36, 97], textColor: [255, 255, 255], fontStyle: 'bold' }, theme: 'grid',
                    didParseCell: (data) => {
                        const levelCol = baseLayerDataPDF ? 4 : 3;
                        if (data.column.index === levelCol && data.section === 'body') {
                            const levelColors = { 'Very High': [8, 29, 88], 'High': [34, 94, 168], 'Moderate': [65, 182, 196], 'Low': [199, 233, 180] };
                            if (levelColors[data.cell.text[0]]) data.cell.styles.textColor = levelColors[data.cell.text[0]];
                        }
                    }
                });
            }

            const pageCount = pdf.internal.getNumberOfPages();
            pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(128, 128, 128);
            for (let i = 1; i <= pageCount; i++) {
                pdf.setPage(i).text(`ZanZemap Report for ${selectedAdminUnit} week ${currentWeek} | Page ${i} of ${pageCount}`, pdfWidth / 2, pdf.internal.pageSize.getHeight() - 10, { align: 'center' });
            }
            pdf.save(`ZanZemap_Report_${new Date().toISOString().split('T')[0]}.pdf`);
        } catch (error) {
            console.error('Error generating report:', error);
            alert(error.message || 'An error occurred while generating the report. Please try again later.');
        } finally {
            document.body.removeChild(loading);
        }
    }

    const geocoderApi = {
        forwardGeocode: async (config) => {
            const features = [];
            try {
                const request = `https://nominatim.openstreetmap.org/search?q=${config.query}&format=geojson&polygon_geojson=1&addressdetails=1`;
                const response = await fetch(request);
                const geojson = await response.json();
                for (const feature of geojson.features) {
                    const center = [feature.bbox[0] + (feature.bbox[2] - feature.bbox[0]) / 2, feature.bbox[1] + (feature.bbox[3] - feature.bbox[1]) / 2];
                    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: center }, place_name: feature.properties.display_name, properties: feature.properties, text: feature.properties.display_name, place_type: ['place'], center });
                }
            } catch (e) { console.error(`Failed to forwardGeocode with error: ${e}`); }
            return { features };
        }
    };
    const geocoder = new MaplibreGeocoder(geocoderApi, { maplibregl, marker: false, placeholder: "Search location...", flyTo: false, collapsed: true });
    map.addControl(geocoder);
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');
    geocoder.on('result', (e) => map.flyTo({ center: e.result.center, zoom: 9 }));

    async function main() {
        setupUI();
        map.on('load', async () => {
            await loadAllBasemaps();
            addOverlayLayers();
            Object.keys(layerCaches).forEach(layerKey => {
                const layerId = `${layerKey}-layer`;
                map.on('click', layerId, handleFeatureClick);
                map.on('mousemove', layerId, () => map.getCanvas().style.cursor = 'pointer');
                map.on('mouseleave', layerId, () => map.getCanvas().style.cursor = '');
            });
            const initialLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
            await toggleThematicLayer(initialLayerType);
            document.getElementById('loadingOverlay').classList.add('hidden');
        });
    }

    function setupUI() {
        const themeToggle = document.getElementById('toggleTheme');
        const applyTheme = (isDark) => {
            document.documentElement.classList.toggle('dark', isDark);
            if (themeToggle) themeToggle.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
            updateAllViews();
        };
        if (themeToggle) themeToggle.addEventListener('click', () => {
            const isDark = !document.documentElement.classList.contains('dark');
            localStorage.setItem('darkMode', isDark);
            applyTheme(isDark);
        });
        applyTheme(localStorage.getItem('darkMode') === 'true');

        document.getElementById('week-slider').addEventListener('input', e => {
            const week = e.target.value;
            const activeLayerType = document.querySelector('input[name="thematic-layer"]:checked').value;
            document.getElementById('week-value').textContent = week;
            document.getElementById('month-display').textContent = weekToMonth[week];
            updateFeatureStatesForWeek(week, activeLayerType);
            updateAllViews();
        });

        document.querySelectorAll('.basemap-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const styleId = this.dataset.style;
                document.querySelectorAll('.basemap-btn').forEach(b => b.classList.toggle('active', b === this));
                Object.keys(allBasemapLayerIds).forEach(key => allBasemapLayerIds[key].forEach(layerId => {
                    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', key === styleId ? 'visible' : 'none');
                }));
            });
        });

        document.querySelectorAll('input[name="thematic-layer"]').forEach(radio => {
            radio.addEventListener('change', async (e) => {
                if (e.target.checked) await toggleThematicLayer(e.target.value);
            });
        });

        const resetSelectionBtn = document.getElementById('reset-selection');
        if (resetSelectionBtn) resetSelectionBtn.addEventListener('click', () => {
            selectedFeatures = [];
            updateAllViews();
        });

        const downloadButton = document.getElementById('downloadButton');
        if (downloadButton) downloadButton.addEventListener('click', generateReport);

        document.getElementById('play-pause-button').addEventListener('click', () => {
            const icon = document.getElementById('play-pause-icon');
            const slider = document.getElementById('week-slider');
            if (animationIntervalId) {
                clearInterval(animationIntervalId);
                animationIntervalId = null;
                icon.classList.replace('fa-pause', 'fa-play');
            } else {
                icon.classList.replace('fa-play', 'fa-pause');
                animationIntervalId = setInterval(() => {
                    let currentWeek = parseInt(slider.value, 10) + 1;
                    if (currentWeek > slider.max) currentWeek = slider.min;
                    slider.value = currentWeek;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                }, 500);
            }
        });
    }

    window.toggleLayerGroup = function (groupId) {
        const group = document.getElementById(groupId);
        const icon = document.getElementById(groupId + '-icon');
        if (!group || !icon) return;
        group.classList.toggle('hidden');
        icon.classList.toggle('fa-chevron-right');
        icon.classList.toggle('fa-chevron-down');
    };

    main();
});