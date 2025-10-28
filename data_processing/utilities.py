# utilities.py

import geopandas as gpd
import pandas as pd

def aggregate_timeseries_vectorized(source_gdf, target_gdf, target_id_col, timeseries_col='timeseries'):
    """
    Aggregates timeseries data from a source GeoDataFrame to a target GeoDataFrame 
    using a highly optimized, vectorized approach.

    This method performs a single spatial overlay, then uses pandas' groupby 
    to calculate area-based weighted means. It is significantly faster than
    iterating through target geometries.

    Args:
        source_gdf (gpd.GeoDataFrame): The GeoDataFrame with the detailed data and 
                                       a timeseries column. The timeseries column
                                       must contain dictionaries.
        target_gdf (gpd.GeoDataFrame): The GeoDataFrame with the larger geometries 
                                       onto which the data will be aggregated.
        target_id_col (str): The name of a UNIQUE identifier column in target_gdf
                             (e.g., 'NUTS_ID', 'PRO_COM'). This is crucial for grouping.
        timeseries_col (str): The name of the column in source_gdf that contains 
                              the timeseries dictionaries. Defaults to 'timeseries'.

    Returns:
        gpd.GeoDataFrame: A copy of the target_gdf with a new column 
                          'timeseries' containing the calculated
                          weighted-average timeseries.
    """
    # --- 1. Validation and Preparation ---
    if timeseries_col not in source_gdf.columns:
        raise ValueError(f"Column '{timeseries_col}' not found in the source GeoDataFrame.")
    if target_id_col not in target_gdf.columns:
        raise ValueError(f"Unique ID column '{target_id_col}' not found in the target GeoDataFrame.")
    if not target_gdf[target_id_col].is_unique:
        raise ValueError(f"Values in the target ID column '{target_id_col}' are not unique. A unique identifier is required.")
        
    # Ensure CRSs match for accurate overlay
    if source_gdf.crs != target_gdf.crs:
        print(f"Warning: CRS mismatch. Reprojecting source_gdf to {target_gdf.crs}")
        source_gdf = source_gdf.to_crs(target_gdf.crs)

    # Project to an equal-area CRS for accurate area calculations
    print("Projecting to EPSG:3035 for accurate area calculation...")
    source_proj = source_gdf.to_crs("EPSG:3035")
    target_proj = target_gdf.to_crs("EPSG:3035")

    # Get a template of time steps from the first valid timeseries
    try:
        time_keys = list(next(item for item in source_proj[timeseries_col] if item is not None).keys())
    except StopIteration:
        print("Warning: No valid timeseries data found. Returning target GDF with empty results.")
        result_gdf = target_gdf.copy()
        result_gdf['timeseries'] = [None] * len(target_gdf)
        return result_gdf

    # --- 2. Vectorized Overlay and Aggregation ---
    print("Performing vectorized spatial overlay...")
    # This is the key step: perform one overlay for ALL polygons at once.
    # We keep only the necessary columns for efficiency.
    intersection_gdf = gpd.overlay(
        source_proj[[timeseries_col, 'geometry']], 
        target_proj[[target_id_col, 'geometry']], 
        how='intersection', 
        keep_geom_type=False
    )
    
    print("Calculating weights and grouping results...")
    # Calculate the area of each intersection fragment to use as a weight.
    intersection_gdf['weight'] = intersection_gdf.geometry.area

    # This function will be applied to each group of intersection fragments.
    def calculate_weighted_ts(group):
        total_weight = group['weight'].sum()
        if total_weight == 0:
            return None
        
        # Calculate the weighted mean for each time step
        new_timeseries = {}
        for t in time_keys:
            # Vectorized calculation within the group for a single time step
            values = group[timeseries_col].apply(lambda ts: ts.get(t, 0) if isinstance(ts, dict) else 0)
            weighted_sum = (values * group['weight']).sum()
            new_timeseries[t] = float(weighted_sum / total_weight)
            
        return new_timeseries

    # Group by the target region's unique ID and apply the function.
    # This is much faster than looping.
    aggregated_series = intersection_gdf.groupby(target_id_col).apply(calculate_weighted_ts)
    
    # --- 3. Finalization ---
    # Merge the results back into the original target GeoDataFrame
    print("Merging results back to target GeoDataFrame...")
    result_gdf = target_gdf.merge(
        aggregated_series.rename('timeseries'),
        left_on=target_id_col,
        right_index=True,
        how='left'
    )
    
    return result_gdf