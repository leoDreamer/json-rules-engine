'use strict'

const Fact = require('./fact')
const Rule = require('./rule')
const Operator = require('./operator')
const Almanac = require('./almanac')
const { EventEmitter } = require('events')
const { SuccessEventFact } = require('./engine-facts')
const defaultOperators = require('./engine-default-operators')
const debug  = require('./debug')

const READY = 'READY'
const RUNNING = 'RUNNING'
const FINISHED = 'FINISHED'

class Engine extends EventEmitter {
  /**
   * Returns a new Engine instance
   * @param  {Rule[]} rules - array of rules to initialize with
   */
  constructor (rules = [], options = {}) {
    super()
    this.rules = []
    this.allowUndefinedFacts = options.allowUndefinedFacts || false
    this.operators = new Map()
    this.facts = new Map()
    this.status = READY
    rules.map(r => this.addRule(r))
    defaultOperators.map(o => this.addOperator(o))
  }

  /**
   * Add a rule definition to the engine
   * @param {object|Rule} properties - rule definition.  can be JSON representation, or instance of Rule
   * @param {integer} properties.priority (>1) - higher runs sooner.
   * @param {Object} properties.event - event to fire when rule evaluates as successful
   * @param {string} properties.event.type - name of event to emit
   * @param {string} properties.event.params - parameters to pass to the event listener
   * @param {Object} properties.conditions - conditions to evaluate when processing this rule
   */
  addRule (properties) {
    if (!properties) throw new Error('Engine: addRule() requires options')
    if (!properties.hasOwnProperty('conditions')) throw new Error('Engine: addRule() argument requires "conditions" property')
    if (!properties.hasOwnProperty('event')) throw new Error('Engine: addRule() argument requires "event" property')

    let rule
    if (properties instanceof Rule) {
      rule = properties
    } else {
      rule = new Rule(properties)
    }
    rule.setEngine(this)

    this.rules.push(rule)
    this.prioritizedRules = null
    return this
  }

  /**
   * Remove a rule from the engine
   * @param {object|Rule} rule - rule definition. Must be a instance of Rule
   */
  removeRule (rule) {
    if ((rule instanceof Rule) === false) throw new Error('Engine: removeRule() rule must be a instance of Rule')

    let index = this.rules.indexOf(rule)
    if (index === -1) return false
    this.prioritizedRules = null
    return Boolean(this.rules.splice(index, 1).length)
  }

  /**
   * Add a custom operator definition
   * @param {string}   operatorOrName - operator identifier within the condition; i.e. instead of 'equals', 'greaterThan', etc
   * @param {function(factValue, jsonValue)} callback - the method to execute when the operator is encountered.
   */
  addOperator (operatorOrName, cb) {
    let operator
    if (operatorOrName instanceof Operator) {
      operator = operatorOrName
    } else {
      operator = new Operator(operatorOrName, cb)
    }
    debug(`engine::addOperator name:${operator.name}`)
    this.operators.set(operator.name, operator)
  }

  /**
   * Remove a custom operator definition
   * @param {string}   operatorOrName - operator identifier within the condition; i.e. instead of 'equals', 'greaterThan', etc
   * @param {function(factValue, jsonValue)} callback - the method to execute when the operator is encountered.
   */
  removeOperator (operatorOrName) {
    let operatorName
    if (operatorOrName instanceof Operator) {
      operatorName = operatorOrName.name
    } else {
      operatorName = operatorOrName
    }

    return this.operators.delete(operatorName)
  }

  /**
   * Add a fact definition to the engine.  Facts are called by rules as they are evaluated.
   * @param {object|Fact} id - fact identifier or instance of Fact
   * @param {function} definitionFunc - function to be called when computing the fact value for a given rule
   * @param {Object} options - options to initialize the fact with. used when "id" is not a Fact instance
   */
  addFact (id, valueOrMethod, options) {
    let factId = id
    let fact
    if (id instanceof Fact) {
      factId = id.id
      fact = id
    } else {
      fact = new Fact(id, valueOrMethod, options)
    }
    debug(`engine::addFact id:${factId}`)
    this.facts.set(factId, fact)
    return this
  }

  /**
   * Add a fact definition to the engine.  Facts are called by rules as they are evaluated.
   * @param {object|Fact} id - fact identifier or instance of Fact
   */
  removeFact (factOrId) {
    let factId
    if (!(factOrId instanceof Fact)) {
      factId = factOrId
    } else {
      factId = factOrId.id
    }

    return this.facts.delete(factId)
  }

  /**
   * Iterates over the engine rules, organizing them by highest -> lowest priority
   * @return {Rule[][]} two dimensional array of Rules.
   *    Each outer array element represents a single priority(integer).  Inner array is
   *    all rules with that priority.
   */
  prioritizeRules () {
    if (!this.prioritizedRules) {
      let ruleSets = this.rules.reduce((sets, rule) => {
        let priority = rule.priority
        if (!sets[priority]) sets[priority] = []
        sets[priority].push(rule)
        return sets
      }, {})
      this.prioritizedRules = Object.keys(ruleSets).sort((a, b) => {
        return Number(a) > Number(b) ? -1 : 1 // order highest priority -> lowest
      }).map((priority) => ruleSets[priority])
    }
    return this.prioritizedRules
  }

  /**
   * Stops the rules engine from running the next priority set of Rules.  All remaining rules will be resolved as undefined,
   * and no further events emitted.  Since rules of the same priority are evaluated in parallel(not series), other rules of
   * the same priority may still emit events, even though the engine is in a "finished" state.
   * @return {Engine}
   */
  stop () {
    this.status = FINISHED
    return this
  }

  /**
   * Returns a fact by fact-id
   * @param  {string} factId - fact identifier
   * @return {Fact} fact instance, or undefined if no such fact exists
   */
  getFact (factId) {
    return this.facts.get(factId)
  }

  /**
   * Runs an array of rules
   * @param  {Rule[]} array of rules to be evaluated
   * @return {Promise} resolves when all rules in the array have been evaluated
   */
  evaluateRules (ruleArray, almanac) {
    return Promise.all(ruleArray.map((rule) => {
      if (this.status !== RUNNING) {
        debug(`engine::run status:${this.status}; skipping remaining rules`)
        return
      }
      return rule.evaluate(almanac).then((ruleResult) => {
        debug(`engine::run ruleResult:${ruleResult.result}`)
        if (ruleResult.result) {
          this.emit('success', rule.event, almanac, ruleResult)
          this.emit(rule.event.type, rule.event.params, almanac, ruleResult)
          almanac.factValue('success-events', { event: rule.event })
        } else {
          this.emit('failure', rule.event, almanac, ruleResult)
        }
      })
    }))
  }

  /**
   * Runs the rules engine
   * @param  {Object} runtimeFacts - fact values known at runtime
   * @param  {Object} runOptions - run options
   * @return {Promise} resolves when the engine has completed running
   */
  run (runtimeFacts = {}) {
    debug(`engine::run started`)
    debug(`engine::run runtimeFacts:`, runtimeFacts)
    runtimeFacts['success-events'] = new Fact('success-events', SuccessEventFact(), { cache: false })
    this.status = RUNNING
    let almanac = new Almanac(this.facts, runtimeFacts)
    let orderedSets = this.prioritizeRules()
    let cursor = Promise.resolve()
    // for each rule set, evaluate in parallel,
    // before proceeding to the next priority set.
    return new Promise((resolve, reject) => {
      orderedSets.map((set) => {
        cursor = cursor.then(() => {
          return this.evaluateRules(set, almanac)
        }).catch(reject)
        return cursor
      })
      cursor.then(() => {
        this.status = FINISHED
        debug(`engine::run completed`)
        resolve(almanac.factValue('success-events'))
      }).catch(reject)
    })
  }

  removeRuleByIndex (index) {
    this.prioritizedRules = null
    return Boolean(this.rules.splice(index, 1).length)
  }

  clearRules () {
    this.prioritizedRules = null
    this.rules = []
  }
}

module.exports = Engine
