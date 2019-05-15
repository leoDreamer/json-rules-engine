const Engine = require('./engine')
const Fact = require('./fact')
const Rule = require('./rule')
const Operator = require('./operator')

// export { Fact, Rule, Operator, Engine }
module.exports = function (rules, options) {
  return new Engine(rules, options)
}
