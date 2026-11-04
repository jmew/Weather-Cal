const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const code = require('../weather-cal-code.js')

function makeFileManager(files = {}) {
  const dates = {}
  for (const path of Object.keys(files)) dates[path] = new Date('2026-11-03T14:00:00Z')
  return {
    files,
    dates,
    documentsDirectory: () => '/documents',
    libraryDirectory: () => '/library',
    joinPath: (a, b) => `${a}/${b}`,
    fileExists: path => Object.hasOwn(files, path),
    readString: path => files[path],
    writeString(path, value) { files[path] = value; dates[path] = new Date() },
    move(source, destination) { files[destination] = files[source]; delete files[source]; dates[destination] = dates[source]; delete dates[source] },
    remove(path) { delete files[path]; delete dates[path] },
    modificationDate: path => dates[path] || new Date(0),
  }
}

function makeCode(files = {}) {
  const instance = Object.create(code)
  instance.fm = makeFileManager(files)
  instance.data = {}
  instance.now = new Date('2026-11-03T15:00:00Z')
  instance.locale = 'en_US'
  instance.settings = { widget: { units: 'metric' }, weather: {} }
  return instance
}

function weather() {
  return {
    current: { temp: 17, dt: 1793718000, weather: [{ id: 800, main: 'Clear' }] },
    daily: Array.from({ length: 8 }, () => ({ sunrise: 1793690000, sunset: 1793730000, temp: { min: 10, max: 20 }, weather: [{ id: 800 }], pop: 0 })),
    hourly: Array.from({ length: 8 }, () => ({ temp: 17, weather: [{ id: 800 }], pop: 0 })),
  }
}

test('offline with no location or weather cache produces placeholders', async () => {
  const instance = makeCode({ '/library/weather-cal-api-key': 'existing-key' })
  global.Location = { current: async () => { throw Error('offline') } }
  global.Device = { locale: () => 'en_US' }
  global.Request = class { constructor() { throw Error('should not request without coordinates') } }
  await instance.setupWeather()
  assert.equal(instance.data.weather.currentTemp, null)
  assert.equal(instance.data.weather.currentCondition, 100)
  assert.equal(instance.data.location.latitude, null)
  assert.equal(await instance.isNight(), instance.now.getHours() < 6 || instance.now.getHours() >= 18)
})

test('failed refresh keeps valid cached weather and working 3.0 endpoint', async () => {
  const cached = weather()
  const instance = makeCode({
    '/library/weather-cal-location': JSON.stringify({ latitude: 37, longitude: -122, locality: 'Cupertino' }),
    '/library/weather-cal-cache': JSON.stringify(cached),
    '/library/weather-cal-api-key': 'existing-key',
  })
  global.Location = { current: async () => { throw Error('offline') } }
  global.Device = { locale: () => 'en_US' }
  let requestUrl
  global.Request = class { constructor(url) { requestUrl = url } async loadJSON() { throw Error('offline') } }
  await instance.setupWeather()
  assert.match(requestUrl, /data\/3\.0\/onecall/)
  assert.equal(instance.data.weather.currentTemp, 17)
  assert.equal(instance.fm.files['/library/weather-cal-cache'], JSON.stringify(cached))
  assert.equal(await instance.isNight(new Date(cached.current.dt * 1000)), false)
})

test('bad cache and API error never replace usable data', async () => {
  const instance = makeCode({
    '/library/weather-cal-location': '{bad',
    '/library/weather-cal-cache': '{bad',
    '/library/weather-cal-api-key': 'existing-key',
  })
  global.Location = { current: async () => ({ latitude: 37, longitude: -122 }), reverseGeocode: async () => [] }
  global.Device = { locale: () => 'en_US' }
  global.Request = class { async loadJSON() { return { cod: 401, message: 'error' } } }
  await instance.setupWeather()
  assert.equal(instance.data.weather.currentTemp, null)
  assert.equal(instance.fm.files['/library/weather-cal-cache'], '{bad')
})

test('weather older than six hours is not displayed as current', async () => {
  const instance = makeCode({
    '/library/weather-cal-location': JSON.stringify({ latitude: 37, longitude: -122 }),
    '/library/weather-cal-cache': JSON.stringify(weather()),
    '/library/weather-cal-api-key': 'existing-key',
  })
  instance.fm.dates['/library/weather-cal-cache'] = new Date('2026-11-02T14:00:00Z')
  global.Device = { locale: () => 'en_US' }
  global.Request = class { async loadJSON() { throw Error('offline') } }
  await instance.setupWeather()
  assert.equal(instance.data.weather.currentTemp, null)
  assert.equal(instance.fm.files['/library/weather-cal-cache'], JSON.stringify(weather()))
})

test('incomplete backend update keeps the installed script', async () => {
  const instance = makeCode({ '/documents/Weather Cal code.js': 'working backend' })
  global.Request = class { async loadString() { return '<html>Server error</html>' } }
  assert.equal(await instance.downloadCode('Weather Cal code', 'https://example.test'), false)
  assert.equal(instance.fm.files['/documents/Weather Cal code.js'], 'working backend')
})

test('validated backend update replaces the installed script', async () => {
  const instance = makeCode({ '/documents/Weather Cal code.js': 'old backend' })
  const newBackend = fs.readFileSync(path.join(__dirname, '..', 'weather-cal-code.js'), 'utf8')
  instance.fm.move = () => { throw new Error('Cannot replace existing destination') }
  global.Request = class { async loadString() { return newBackend } }
  assert.equal(await instance.downloadCode('Weather Cal code', 'https://example.test'), true)
  assert.equal(instance.fm.files['/documents/Weather Cal code.js'], newBackend)
  assert.equal(instance.fm.fileExists('/documents/Weather Cal code.js.download'), false)
  assert.equal(instance.fm.files['/library/weather-cal-script-backup-Weather%20Cal%20code.txt'], 'old backend')
})

test('backup failure leaves installed script untouched and identifies the failing step', async () => {
  const instance = makeCode({ '/documents/Weather Cal code.js': 'old backend' })
  const newBackend = fs.readFileSync(path.join(__dirname, '..', 'weather-cal-code.js'), 'utf8')
  global.Request = class { async loadString() { return newBackend } }
  instance.fm.writeString = () => { throw new Error('Storage unavailable') }
  assert.equal(await instance.downloadCode('Weather Cal code', 'https://example.test'), false)
  assert.equal(instance.fm.files['/documents/Weather Cal code.js'], 'old backend')
  assert.match(instance.updateError, /Backing up installed code failed: Storage unavailable/)
})

test('failed overwrite restores the previous code', async () => {
  const instance = makeCode({ '/documents/Weather Cal code.js': 'old backend' })
  const newBackend = fs.readFileSync(path.join(__dirname, '..', 'weather-cal-code.js'), 'utf8')
  global.Request = class { async loadString() { return newBackend } }
  const write = instance.fm.writeString.bind(instance.fm)
  instance.fm.writeString = (file, value) => {
    if (file == '/documents/Weather Cal code.js' && value == newBackend) {
      instance.fm.files[file] = 'partial write'
      throw new Error('Write failed')
    }
    write(file, value)
  }
  assert.equal(await instance.downloadCode('Weather Cal code', 'https://example.test'), false)
  assert.equal(instance.fm.files['/documents/Weather Cal code.js'], 'old backend')
  assert.match(instance.updateError, /previous code was restored/)
})

test('network failure reports the download step and keeps installed code', async () => {
  const instance = makeCode({ '/documents/Weather Cal code.js': 'old backend' })
  global.Request = class { async loadString() { throw new Error('Offline') } }
  assert.equal(await instance.downloadCode('Weather Cal code', 'https://example.test'), false)
  assert.equal(instance.fm.files['/documents/Weather Cal code.js'], 'old backend')
  assert.match(instance.updateError, /Downloading code failed: Offline/)
})

test('real layout tokens still resolve to widget items', () => {
  for (const item of ['date', 'events', 'reminders', 'greeting', 'current']) {
    assert.equal(typeof code[item], 'function')
  }
})

test('legacy widget preferences remain readable', () => {
  const instance = makeCode({
    '/library/weather-cal-preferences-My Widget': JSON.stringify({
      widget: { units: 'metric', padding: '4', tintIcons: false },
      events: { selectCalendars: 'Work,Home,Jemew/Cli,Calendar,jemew@google.com' },
      reminders: { numberOfReminders: '4' },
      weather: { urlCurrent: 'weather://' },
    }),
  })
  instance.prefPath = '/library/weather-cal-preferences-My Widget'
  const settings = instance.getSettings()
  assert.equal(settings.widget.units, 'metric')
  assert.equal(settings.events.selectCalendars, 'Work,Home,Jemew/Cli,Calendar,jemew@google.com')
  assert.equal(settings.reminders.numberOfReminders, '4')
  assert.equal(settings.weather.urlCurrent, 'weather://')
})

test('starter widget fetches the same nosunrise branch', () => {
  const starter = fs.readFileSync(path.join(__dirname, '..', 'weather-cal.js'), 'utf8')
  assert.match(starter, /jmew\/Weather-Cal\/refs\/heads\/nosunrise\/weather-cal-code\.js/)
})
