#!/usr/bin/env python
# coding: utf-8

# # Data Preprocessing Notebook

# In[8]:


import xarray as xr
import geopandas as gpd
import numpy as np
from shapely.geometry import Polygon
import json
from utilities import aggregate_timeseries_vectorized


# ## 0 Load file

# ---
# 
# This is the input file, the only "moving" part.

# In[ ]:


ds = xr.open_dataset("data/in_updatable/albo_alpine_ML_Standardised_MeanSpatPred.nc")
# ds # Inspect dataset


# ---

# # 1 Convert and save file 

# In[10]:

crs = "EPSG:4326"
da = ds["Std_alboeggs"]  # dims: (time/Z1, latitude, longitude)

# --- STANDARDISATION LOGIC START ---
# Determine which time dimension is present and create a standardized list of keys (e.g., 1, 2... 52)
if "time" in ds.coords:
    print("Detected 'time' coordinate (datetime). Converting to week numbers.")
    # Extract ISO week numbers from datetimes (returns integers 1-52/53)
    # We use .values to get a numpy array for speed in the loop
    time_keys = ds["time"].dt.isocalendar().week.values
elif "Z1" in ds.coords:
    print("Detected 'Z1' coordinate (integer). Using values directly.")
    time_keys = ds["Z1"].values
else:
    raise ValueError("Dataset dimensions must contain either 'time' or 'Z1'")
# --- STANDARDISATION LOGIC END ---

lons = ds["longitude"].values
lats = ds["latitude"].values

lon_edges = np.concatenate([
    [lons[0] - (lons[1] - lons[0]) / 2],
    (lons[:-1] + lons[1:]) / 2,
    [lons[-1] + (lons[-1] - lons[-2]) / 2]
])
lat_edges = np.concatenate([
    [lats[0] - (lats[0] - lats[1]) / 2],
    (lats[:-1] + lats[1:]) / 2,
    [lats[-1] + (lats[-2] - lats[-1]) / 2]
])

polygons, timeseries, names = [], [], []
cell_id = 0

for lat_i, lat in enumerate(lats):
    for lon_i, lon in enumerate(lons):
        cell_id += 1
        poly = Polygon([
            (lon_edges[lon_i],   lat_edges[lat_i]),
            (lon_edges[lon_i+1], lat_edges[lat_i]),
            (lon_edges[lon_i+1], lat_edges[lat_i+1]),
            (lon_edges[lon_i],   lat_edges[lat_i+1])
        ])

        # Timeseries for this cell
        # We use positional indexing [:, lat, lon] which works for both (time,...) and (Z1,...)
        series = da[:, lat_i, lon_i].values
        
        # Use the pre-calculated time_keys here instead of ds["time"]
        ts_dict = {str(int(z)): (None if np.isnan(v) else float(v)) 
                   for z, v in zip(time_keys, series)}

        # Only keep if at least one value is not None
        if any(v is not None for v in ts_dict.values()):
            polygons.append(poly)
            names.append(f"Cell {cell_id}")
            timeseries.append(ts_dict)

# Build GeoDataFrame
gdf = gpd.GeoDataFrame(
    {"timeseries": timeseries, "geometry": polygons, "name": names},
    crs=crs
)

import hashlib
from shapely.geometry.polygon import orient
from shapely import set_precision

def make_numeric_hash(geom):
    geom = orient(geom, sign=1.0)              # normalize orientation
    geom = set_precision(geom, grid_size=1e-6) # round coordinates
    geom_bytes = geom.wkb                      # binary form
    hash_val = int(hashlib.md5(geom_bytes).hexdigest(), 16)
    return str(hash_val % 10**10).zfill(10)


gdf["name"] = gdf["geometry"].apply(make_numeric_hash)

print(f"✅ Final GDF has {len(gdf)} cells (filtered)")

#############################################
# add study area boolean flag for limited version 
study_area_extent = gpd.read_parquet("../data_processing/data/in/study_area_extent_trentino.parquet")
if gdf.crs != study_area_extent.crs:
    study_area_extent = study_area_extent.to_crs(gdf.crs)
clip_geom = study_area_extent.union_all() 
gdf["study_area_extent_trentino"] = gdf.intersects(clip_geom)
#############################################

gdf.to_file("../public/data/out/model_output_trentino_2025.fgb")


# ## 2 NUTS3 processing

# In[11]:


nuts = gpd.read_file("data/in/EU_NUTS3_01M.fgb")

nuts = aggregate_timeseries_vectorized(
    source_gdf=gdf, 
    target_gdf=nuts, 
    target_id_col='NUTS_ID', # <-- Specify the unique ID column here
    timeseries_col='timeseries'
)

nuts["name"] = nuts["NAME_LATN"]
nuts = nuts[["geometry","timeseries", "name"]]
#nuts = nuts[nuts["timeseries"].notnull()]

###########################################################
# quick fix as there are not enough data avilable for other nuts3 regions, delete everything but Trento
#nuts.loc[nuts["name"] != "Trento", "timeseries"] = None
###########################################################
nuts["study_area_extent_trentino"] = False
nuts.loc[nuts.name == "Trento", "study_area_extent_trentino"] = True

nuts.to_file("../public/data/out/EU_NUTS3_01M_2025.fgb")

nuts

# should run in a few seconds!


# ## 3 Comuni processing

# In[12]:


comuni = gpd.read_file("data/in/IT_comuni.fgb")
# dissolving by COMUNE name probably not a good idea as there are actual correct duplicates. If the data were correct, this code could be used
# comuni = comuni.dissolve(by="COMUNE").reset_index()
# instead, just using a unique id here 

comuni["unique_id"] = comuni.index + 1 # Create a unique ID column if not present

comuni = aggregate_timeseries_vectorized(
    source_gdf=gdf, 
    target_gdf=comuni, 
    target_id_col='unique_id', # <-- Specify the unique ID column here
    timeseries_col='timeseries'
)

del comuni["unique_id"]
comuni["name"] = comuni["COMUNE"]
del comuni["COMUNE"]

comuni["study_area_extent_trentino"] = comuni.intersects(clip_geom)
comuni.to_file("../public/data/out/IT_comuni_2025.fgb")

comuni.loc[comuni['timeseries'].notna()].head()


# In[13]:


comuni.loc[comuni['study_area_extent_trentino'] == True].plot()


# In[14]:


comuni.loc[comuni['timeseries'].notna()].plot()


# In[ ]:




