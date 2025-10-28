# ZanZeMap

Mosquito map developed for Fondazione Edmund Mach, displayed on https://www.zanzemap.it/.
See LICENSE.md for licensing conditions.

## Data updates with Python scripts 

**tl;dr: Just update this file `data_processing/data/in_updatable/albo_alpine_ML_Standardised_MeanSpatPred.nc` and run `uv run --python 3.12 --with-requirements requirements.txt process_netcdf_layers.py` (<30 seconds).<br>
Then copy all the files from directory `public/data/out` that end on `_2025` to `https://zanzemap.it/`.**

Detailed explanation:

### 1. Update the file 

Just overwrite this file `data_processing/data/in_updatable/albo_alpine_ML_Standardised_MeanSpatPred.nc` with the new one. Keep the same name.

### 2. Run the script 

Install uv: https://docs.astral.sh/uv/getting-started/installation/#installing-uv.

```python
uv run --python 3.12 --with-requirements requirements.txt process_netcdf_layers.py
```

First run will take a minute depending on your internet speed. Following runs will be much faster as the dependencies are cached.

### 3. Copy outputs

Copy these files
```
data/out/EU_NUTS3_01M_2025.fgb
data/out/IT_comuni_2025.fgb
data/out/model_output_trentino_2025.fgb
```

to `https://zanzemap.it/`. Done. You should see the update after a site refresh in the browser.

### Misc

- `process_geojson_layers_5_years_mean.ipynb` is how I preprocessed all the 5 years mean layers. This notebook should not be run again. 
- `utilities.py` includes utility functions called in the notebooks
- I converted the jupater notebook to plain python with `jupyter nbconvert process_netcdf_layers.ipynb --to python` 
---

## Appendix 

### 1 Run script as notebook 

For debugging the notebook can be run with these steps: 

Create kernel: Install anaconda or miniconda, then run these commands once to create a virtual environment and install all dependencies: 

```shell
cd data_processing
conda create --name zanzemap python=3.12
conda activate zanzemap
pip install -r requirements.txt
```
Optionally if you have [uv](https://docs.astral.sh/uv/) installed replace `pip` by `uv pip` for faster setup.

Simply head over to your favorite notebook IDE (like VS Code), open the notebook and select the kernel `zanzemap` and run all cells.


### 2 Netcdf file specifics

Can be checked in python with 

```python
import xarray as xr
ds = xr.open_dataset("data/in_updatable/albo_alpine_ML_Standardised_MeanSpatPred.nc")
ds
```

**1. Dimensions:** Axes 
*   **`Z1` (size: 32):** 
*   **`latitude` (size: 76):**
*   **`longitude` (size: 151):** 

**2. Coordinates:** 
*   **`longitude`:** An array of 151 floating-point numbers, ranging from 2.15 to 17.15. 
*   **`latitude`:** An array of 76 floating-point numbers, ranging from 50.55 down to 43.05. 
*   **`Z1`:** An array of 32 floating-point numbers from 1.0 to 32.0. 

**3. Data Variables:** These are the actual data arrays. 
*   **`Std_alboeggs`:** A 3-dimensional array with the shape (32, 76, 151), corresponding to the `Z1`, `latitude`, and `longitude` dimensions. It contains 367,232 data points of type `float32`. Standard deviation of mosquito (specifically *Aedes albopictus*) egg counts. 
*   **`crs`:** Coordinate Reference System (CRS) of the data.

### 3 Run and build webapp locally

#### Local run and build 
Install dependencies (assumes node.js is installed)

```shell
npm install 
```

For local development start server with

```shell
npm run dev 
```

Build with 

```shell
npm run build
```

If you want to check the distribution files after build, cd into `dist` folder and run a web server

```shell 
npx server
```

This serves all the generated static files locally. Do not use `python3 -m http.server 8080` as it doesnt include all relevant mime types for wasm, relevant for maplibre! So the app will appear broken even though it isn't.

#### Adding password for full version `index.html`


