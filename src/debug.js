module.exports = function debug (message) {
  if (process.env.DEBUG && process.env.DEBUG.match(/json-rules-engine/)) {
    console.log(message)
  }
}
