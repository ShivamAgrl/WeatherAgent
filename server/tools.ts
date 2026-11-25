import Anthropic from "@anthropic-ai/sdk";

// Open-Meteo: free, no API key required.
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

type Units = "metric" | "imperial";

export const tools: Anthropic.Tool[] = [
    {
        name: "get_current_weather",
        description:
            "Get the current weather conditions (temperature, feels-like, humidity, wind, precipitation, sky condition) for a city.",
        strict: true,
        input_schema: {
            type: "object",
            properties: {
                city: { type: "string", description: "City name, optionally with country, e.g. 'Paris' or 'Paris, France'" },
                units: { type: "string", enum: ["metric", "imperial"], description: "metric = °C, km/h, mm; imperial = °F, mph, inch" },
            },
            required: ["city", "units"],
            additionalProperties: false,
        },
    },
    {
        name: "get_forecast",
        description:
            "Get the daily weather forecast for a city: high/low temperature, precipitation chance and amount, max wind, and sky condition per day. Day 1 is today.",
        strict: true,
        input_schema: {
            type: "object",
            properties: {
                city: { type: "string", description: "City name, optionally with country" },
                days: { type: "integer", description: "Number of days to forecast, 1 to 16" },
                units: { type: "string", enum: ["metric", "imperial"] },
            },
            required: ["city", "days", "units"],
            additionalProperties: false,
        },
    },
    {
        name: "get_hourly_forecast",
        description:
            "Get an hour-by-hour forecast for a city starting from the current hour: condition, temperature, feels-like, precipitation chance and amount, wind, UV index, and daylight. Use it to find the best time window for an activity.",
        strict: true,
        input_schema: {
            type: "object",
            properties: {
                city: { type: "string", description: "City name, optionally with country" },
                hours: { type: "integer", description: "Number of hours to forecast from now, 1 to 72" },
                units: { type: "string", enum: ["metric", "imperial"] },
            },
            required: ["city", "hours", "units"],
            additionalProperties: false,
        },
    },
    {
        name: "get_air_quality",
        description:
            "Get current air quality for a city (US AQI with category, PM2.5, PM10, ozone, NO2, UV index, and pollen where available) plus an hourly AQI/PM2.5 forecast. Use it for health or outdoor-safety questions.",
        strict: true,
        input_schema: {
            type: "object",
            properties: {
                city: { type: "string", description: "City name, optionally with country" },
                hours: { type: "integer", description: "Hours of AQI forecast to include from now, 0 to 120 (0 = current conditions only)" },
            },
            required: ["city", "hours"],
            additionalProperties: false,
        },
    },
];

// WMO weather interpretation codes used by Open-Meteo.
const WMO_CODES: Record<number, string> = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

const describe = (code: number) => WMO_CODES[code] ?? `Unknown (code ${code})`;

function unitParams(units: Units) {
    return units === "imperial"
        ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch" }
        : { temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm" };
}

async function getJson(url: string, params: Record<string, string | number>): Promise<any> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${url}?${qs}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Weather service returned HTTP ${res.status}`);
    return res.json();
}

async function geocode(city: string) {
    // The geocoder matches on the place name only, so search by the part before the first comma
    // and use the remainder (if any) to prefer a matching country/region.
    const [name, ...rest] = city.split(",").map((s) => s.trim());
    const hint = rest.join(" ").toLowerCase();
    const data = await getJson(GEOCODE_URL, { name, count: 10, language: "en", format: "json" });
    const results: any[] = data.results ?? [];
    if (results.length === 0) throw new Error(`Could not find a location named "${city}".`);
    const match =
        (hint &&
            results.find((r) =>
                [r.country, r.country_code, r.admin1].some((f) => f && String(f).toLowerCase().includes(hint)),
            )) ||
        results[0];
    return {
        name: [match.name, match.admin1, match.country].filter(Boolean).join(", "),
        latitude: match.latitude as number,
        longitude: match.longitude as number,
    };
}

async function getCurrentWeather(city: string, units: Units) {
    const loc = await geocode(city);
    const data = await getJson(FORECAST_URL, {
        latitude: loc.latitude,
        longitude: loc.longitude,
        current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day",
        timezone: "auto",
        ...unitParams(units),
    });
    const c = data.current;
    const u = data.current_units;
    return {
        location: loc.name,
        local_time: c.time,
        timezone: data.timezone,
        condition: describe(c.weather_code),
        is_day: c.is_day === 1,
        temperature: `${c.temperature_2m}${u.temperature_2m}`,
        feels_like: `${c.apparent_temperature}${u.apparent_temperature}`,
        humidity: `${c.relative_humidity_2m}${u.relative_humidity_2m}`,
        precipitation: `${c.precipitation} ${u.precipitation}`,
        wind: `${c.wind_speed_10m} ${u.wind_speed_10m} from ${c.wind_direction_10m}°`,
    };
}

async function getForecast(city: string, days: number, units: Units) {
    const loc = await geocode(city);
    const data = await getJson(FORECAST_URL, {
        latitude: loc.latitude,
        longitude: loc.longitude,
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
        forecast_days: days,
        timezone: "auto",
        ...unitParams(units),
    });
    const d = data.daily;
    const u = data.daily_units;
    return {
        location: loc.name,
        timezone: data.timezone,
        days: d.time.map((date: string, i: number) => ({
            date,
            condition: describe(d.weather_code[i]),
            high: `${d.temperature_2m_max[i]}${u.temperature_2m_max}`,
            low: `${d.temperature_2m_min[i]}${u.temperature_2m_min}`,
            precipitation_chance: `${d.precipitation_probability_max[i] ?? "n/a"}${u.precipitation_probability_max}`,
            precipitation_total: `${d.precipitation_sum[i]} ${u.precipitation_sum}`,
            max_wind: `${d.wind_speed_10m_max[i]} ${u.wind_speed_10m_max}`,
        })),
    };
}

async function getHourlyForecast(city: string, hours: number, units: Units) {
    const loc = await geocode(city);
    const data = await getJson(FORECAST_URL, {
        latitude: loc.latitude,
        longitude: loc.longitude,
        hourly: "weather_code,temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,uv_index,is_day",
        forecast_hours: hours,
        timezone: "auto",
        ...unitParams(units),
    });
    const h = data.hourly;
    const u = data.hourly_units;
    return {
        location: loc.name,
        timezone: data.timezone,
        hours: h.time.map((time: string, i: number) => ({
            time,
            condition: describe(h.weather_code[i]),
            is_day: h.is_day[i] === 1,
            temperature: `${h.temperature_2m[i]}${u.temperature_2m}`,
            feels_like: `${h.apparent_temperature[i]}${u.apparent_temperature}`,
            precipitation_chance: `${h.precipitation_probability[i] ?? "n/a"}${u.precipitation_probability}`,
            precipitation: `${h.precipitation[i]} ${u.precipitation}`,
            wind: `${h.wind_speed_10m[i]} ${u.wind_speed_10m}`,
            uv_index: h.uv_index[i],
        })),
    };
}

// US EPA AQI bands, computed here so the model never has to guess the category.
function aqiCategory(aqi: number | null): string {
    if (aqi == null) return "Unknown";
    if (aqi <= 50) return "Good";
    if (aqi <= 100) return "Moderate";
    if (aqi <= 150) return "Unhealthy for Sensitive Groups";
    if (aqi <= 200) return "Unhealthy";
    if (aqi <= 300) return "Very Unhealthy";
    return "Hazardous";
}

const POLLEN_FIELDS = ["alder_pollen", "birch_pollen", "grass_pollen", "mugwort_pollen", "olive_pollen", "ragweed_pollen"];

async function getAirQuality(city: string, hours: number) {
    const loc = await geocode(city);
    const data = await getJson(AIR_QUALITY_URL, {
        latitude: loc.latitude,
        longitude: loc.longitude,
        current: ["us_aqi", "pm2_5", "pm10", "ozone", "nitrogen_dioxide", "uv_index", ...POLLEN_FIELDS].join(","),
        ...(hours > 0 && { hourly: "us_aqi,pm2_5", forecast_hours: hours }),
        timezone: "auto",
    });
    const c = data.current;
    const u = data.current_units;
    // Pollen is only modelled for Europe; elsewhere the API returns nulls.
    const pollen = Object.fromEntries(
        POLLEN_FIELDS.filter((f) => c[f] != null).map((f) => [f.replace("_pollen", ""), `${c[f]} ${u[f]}`]),
    );
    const h = data.hourly;
    return {
        location: loc.name,
        local_time: c.time,
        timezone: data.timezone,
        us_aqi: c.us_aqi,
        aqi_category: aqiCategory(c.us_aqi),
        pm2_5: `${c.pm2_5} ${u.pm2_5}`,
        pm10: `${c.pm10} ${u.pm10}`,
        ozone: `${c.ozone} ${u.ozone}`,
        nitrogen_dioxide: `${c.nitrogen_dioxide} ${u.nitrogen_dioxide}`,
        uv_index: c.uv_index,
        pollen: Object.keys(pollen).length > 0 ? pollen : "Not available for this region (pollen data covers Europe only)",
        ...(h && {
            forecast: h.time.map((time: string, i: number) => ({
                time,
                us_aqi: h.us_aqi[i],
                aqi_category: aqiCategory(h.us_aqi[i]),
                pm2_5: `${h.pm2_5[i]} ${data.hourly_units.pm2_5}`,
            })),
        }),
    };
}

// Input validation: never trust tool input blindly, even with strict schemas.
function requireCity(input: any): string {
    const city = typeof input?.city === "string" ? input.city.trim() : "";
    if (!city) throw new Error("Missing required field 'city'.");
    return city;
}

function requireUnits(input: any): Units {
    if (input?.units !== "metric" && input?.units !== "imperial") {
        throw new Error("Field 'units' must be 'metric' or 'imperial'.");
    }
    return input.units;
}

function requireDays(input: any): number {
    const days = Number(input?.days);
    if (!Number.isInteger(days) || days < 1 || days > 16) {
        throw new Error("Field 'days' must be an integer between 1 and 16.");
    }
    return days;
}

function requireHours(input: any, min: number, max: number): number {
    const hours = Number(input?.hours);
    if (!Number.isInteger(hours) || hours < min || hours > max) {
        throw new Error(`Field 'hours' must be an integer between ${min} and ${max}.`);
    }
    return hours;
}

/** Runs a tool and returns its JSON-serialized result. Throws on failure; the caller reports it as is_error. */
export async function runTool(name: string, input: unknown): Promise<string> {
    switch (name) {
        case "get_current_weather":
            return JSON.stringify(await getCurrentWeather(requireCity(input), requireUnits(input)));
        case "get_forecast":
            return JSON.stringify(await getForecast(requireCity(input), requireDays(input), requireUnits(input)));
        case "get_hourly_forecast":
            return JSON.stringify(await getHourlyForecast(requireCity(input), requireHours(input, 1, 72), requireUnits(input)));
        case "get_air_quality":
            return JSON.stringify(await getAirQuality(requireCity(input), requireHours(input, 0, 120)));
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
