const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const weatherCal = require("../weather-cal-code.js")

function makeWidget(files = {}) {
  const dates = Object.fromEntries(Object.keys(files).map(path => [path, new Date()]))
  const fm = {
    libraryDirectory: () => "/library",
    documentsDirectory: () => "/docs",
    joinPath: (dir, name) => dir + "/" + name,
    fileExists: path => Object.hasOwn(files, path),
    readString: path => files[path],
    writeString: (path, value) => { files[path] = value; dates[path] = new Date() },
    move: (source, destination) => { files[destination] = files[source]; delete files[source] },
    remove: path => { delete files[path] },
    modificationDate: path => dates[path] || new Date(0),
  }
  const widget = Object.create(weatherCal)
  widget.fm = fm
  widget.now = new Date()
  widget.locale = "en_US"
  widget.settings = { widget: { units: "imperial" }, weather: { locale: "" } }
  widget.data = { location: { latitude: 40, longitude: -74 } }
  return { widget, files, dates }
}

const forecast = {
  current: { temp: 70, weather: [{ id: 800, main: "Clear", description: "clear sky" }] },
  daily: Array.from({ length: 8 }, () => ({ temp: { max: 75, min: 60 }, weather: [{ id: 800 }], pop: 0.3, sunrise: 1762178400, sunset: 1762218000 })),
  hourly: Array.from({ length: 8 }, () => ({ temp: 70, weather: [{ id: 800 }], pop: 0.2 })),
}

test("existing API key and saved path are reused without probing another endpoint", async () => {
  const { widget, files } = makeWidget({
    "/library/weather-cal-api-key": "existing-key",
    "/library/weather-cal-api-path": "https://api.openweathermap.org/data/3.0/onecall",
  })
  let requests = 0
  global.Device = { locale: () => "en_US" }
  global.Request = class {
    constructor(url) {
      assert.match(url, /\/data\/3\.0\/onecall\?appid=existing-key&lat=40&lon=-74/)
      requests++
    }
    async loadJSON() { return forecast }
  }
  await widget.setupWeather()
  assert.equal(requests, 1)
  assert.equal(widget.data.weather.currentTemp, 70)
  assert.equal(files["/library/weather-cal-api-path"], "https://api.openweathermap.org/data/3.0/onecall")
})

test("API detection saves the endpoint accepted by a new key", async () => {
  const { widget, files } = makeWidget()
  global.Request = class {
    constructor(url) { this.url = url }
    async loadJSON() { return this.url.includes("/3.0/") ? { cod: 401 } : forecast }
  }
  const result = await widget.getWeatherApiPath("new-key")
  assert.equal(result, forecast)
  assert.equal(files["/library/weather-cal-api-path"], "https://api.openweathermap.org/data/2.5/onecall")
})

test("COVID item and preferences are removed", async () => {
  const { widget } = makeWidget()
  const settings = await widget.defaultSettings()
  for (const item of ["date", "sunset", "battery", "events", "current", "future"]) {
    assert.equal(typeof weatherCal[item], "function", `${item} remains available to the widget layout`)
  }
  assert.equal("covid" in weatherCal, false)
  assert.equal("setupCovid" in weatherCal, false)
  assert.equal("covid" in settings, false)
  assert.equal("covid" in settings.localization, false)
  assert.equal("covid" in settings.font, false)
})

test("offline refresh without cached location or weather uses placeholders", async () => {
  const { widget } = makeWidget({ "/library/weather-cal-api-key": "existing-key" })
  widget.data = {}
  widget.settings.widget.updateLocation = "60"
  global.Device = { locale: () => "en_US" }
  global.Location = { current: async () => { throw new Error("offline") } }
  global.Request = class { constructor() { throw new Error("should not request without coordinates") } }

  await widget.setupWeather()
  await widget.setupSunrise()
  assert.equal(widget.data.location.locality, "--")
  assert.equal(widget.data.weather.currentTemp, null)
  assert.equal(widget.data.sun.sunrise, null)
})

test("offline refresh keeps a valid cached forecast for up to six hours", async () => {
  const { widget, files, dates } = makeWidget({
    "/library/weather-cal-api-key": "existing-key",
    "/library/weather-cal-api-path": "https://api.openweathermap.org/data/3.0/onecall",
    "/library/weather-cal-cache": JSON.stringify(forecast),
  })
  dates["/library/weather-cal-cache"] = new Date(widget.now.getTime() - 2 * 60 * 60 * 1000)
  global.Device = { locale: () => "en_US" }
  global.Request = class { async loadJSON() { throw new Error("offline") } }

  await widget.setupWeather()
  assert.equal(widget.data.weather.currentTemp, 70)
  assert.equal(JSON.parse(files["/library/weather-cal-cache"]).current.temp, 70)
})

test("API error does not replace a usable cached forecast", async () => {
  const { widget, files, dates } = makeWidget({
    "/library/weather-cal-api-key": "existing-key",
    "/library/weather-cal-api-path": "https://api.openweathermap.org/data/3.0/onecall",
    "/library/weather-cal-cache": JSON.stringify(forecast),
  })
  dates["/library/weather-cal-cache"] = new Date(widget.now.getTime() - 2 * 60 * 60 * 1000)
  global.Device = { locale: () => "en_US" }
  global.Request = class { async loadJSON() { return { cod: 401 } } }

  await widget.setupWeather()
  assert.equal(widget.data.weather.currentTemp, 70)
  assert.equal(JSON.parse(files["/library/weather-cal-cache"]).current.temp, 70)
})

test("corrupt cache is ignored safely", async () => {
  const { widget } = makeWidget({ "/library/weather-cal-cache": "invalid json" })
  assert.equal(widget.getCache("/library/weather-cal-cache", 1, 360), null)
})

test("malformed weather response without cache uses placeholders", async () => {
  const { widget } = makeWidget({
    "/library/weather-cal-api-key": "existing-key",
    "/library/weather-cal-api-path": "https://api.openweathermap.org/data/3.0/onecall",
  })
  global.Device = { locale: () => "en_US" }
  global.Request = class { async loadJSON() { return { current: {}, daily: [] } } }
  await widget.setupWeather()
  assert.equal(widget.data.weather.currentTemp, null)
  assert.equal(widget.data.weather.forecast[1].Condition, 100)
})

test("damaged preferences fall back to defaults without overwriting the file", async () => {
  const { widget, files } = makeWidget({ "/library/preferences": "invalid json" })
  widget.prefPath = "/library/preferences"
  const settings = await widget.getSettings()
  assert.equal(settings.widget.units, "imperial")
  assert.equal(files["/library/preferences"], "invalid json")
})

test("the widget script imports a previously installed backend while offline", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../weather-cal.js"), "utf8")
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
  let importedName, renderedWidget
  const fm = {
    isFileStoredIniCloud: () => true,
    documentsDirectory: () => "/docs",
    joinPath: (dir, name) => dir + "/" + name,
    fileExists: file => file == "/docs/Weather Cal code.js",
    downloadFileFromiCloud: async () => { throw new Error("offline") },
  }
  const FileManager = { local: () => fm, iCloud: () => fm }
  const Script = {
    name: () => "My Weather Cal",
    setWidget: widget => { renderedWidget = widget },
    complete: () => {},
  }
  const importModule = name => {
    importedName = name
    return { createWidget: async () => ({ id: "rendered" }) }
  }
  const Request = class { constructor() { throw new Error("unexpected network request") } }
  const run = new AsyncFunction("FileManager", "module", "Request", "importModule", "config", "Script", source)
  await run(FileManager, { filename: "/docs/My Weather Cal.js" }, Request, importModule, { runsInApp: false }, Script)
  assert.equal(importedName, "Weather Cal code")
  assert.deepEqual(renderedWidget, { id: "rendered" })
})

test("failed or partial backend updates preserve the installed script", async () => {
  const oldCode = "working installed backend"
  const { widget, files } = makeWidget({ "/docs/Weather Cal code.js": oldCode })
  global.Request = class { async loadString() { throw new Error("offline") } }
  assert.equal(await widget.downloadCode("Weather Cal code", "https://example.test/backend.js"), false)
  assert.equal(files["/docs/Weather Cal code.js"], oldCode)

  global.Request = class { async loadString() { return "// Variables used by Scriptable.\npartial" } }
  assert.equal(await widget.downloadCode("Weather Cal code", "https://example.test/backend.js"), false)
  assert.equal(files["/docs/Weather Cal code.js"], oldCode)
  assert.equal(files["/docs/Weather Cal code.js.download"], undefined)
})

test("complete backend update replaces the script after validation", async () => {
  const { widget, files } = makeWidget({ "/docs/Weather Cal code.js": "old code" })
  const newCode = fs.readFileSync(path.join(__dirname, "../weather-cal-code.js"), "utf8")
  global.Request = class { async loadString() { return newCode } }
  assert.equal(await widget.downloadCode("Weather Cal code", "https://example.test/backend.js"), true)
  assert.equal(files["/docs/Weather Cal code.js"], newCode)
  assert.equal(files["/docs/Weather Cal code.js.download"], undefined)
})

test("widget reset still accepts the complete launcher script", async () => {
  const { widget, files } = makeWidget({ "/docs/My Weather Cal.js": "old code" })
  const newCode = fs.readFileSync(path.join(__dirname, "../weather-cal.js"), "utf8")
  global.Request = class { async loadString() { return newCode } }
  assert.equal(await widget.downloadCode("My Weather Cal", "https://example.test/widget.js"), true)
  assert.equal(files["/docs/My Weather Cal.js"], newCode)
})

test("existing ASCII layout items remain recognized", async () => {
  const { widget } = makeWidget()
  const layout = `
-------------------
|date             |
-------------------
|events |reminders|
-------------------
|space            |
-------------------
|         greeting|
-------------------
|          current|
-------------------
`
  widget.currentColumns = []
  widget.rowNeedsSetup = false
  widget.currentColumn = {}
  const found = []
  widget.row = () => {}
  widget.column = () => {}
  widget.executeItem = async item => { found.push(item) }
  for (const line of layout.split("\n").map(line => line.trim()).filter(Boolean)) {
    await widget.processASCIILine(line)
  }
  for (const item of ["date", "events", "reminders", "space", "greeting", "current"]) {
    assert.ok(found.includes(item), `${item} is parsed from the existing layout`)
  }
})

test("older saved preference values remain usable", async () => {
  const oldSettings = {
    widget: { units: "metric", padding: "4", tintIcons: false },
    events: { selectCalendars: "Work,Home", numberOfDays: "2" },
    reminders: { selectLists: "", numberOfReminders: "4" },
    weather: { horizontalCondition: true, showRain: true, urlCurrent: "weather://" },
  }
  const { widget } = makeWidget({ "/library/preferences": JSON.stringify(oldSettings) })
  widget.prefPath = "/library/preferences"
  const settings = await widget.getSettings()
  assert.equal(settings.widget.units, "metric")
  assert.equal(settings.events.selectCalendars, "Work,Home")
  assert.equal(settings.reminders.numberOfReminders, "4")
  assert.equal(settings.weather.urlCurrent, "weather://")
})
