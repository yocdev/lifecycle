// The timer functions will be managed (wrapped) by TimerManager
// when TimerManager package required. So require lifecycle package
// as early as possible to trace all the timer function invokes.
const TimerManager = require('@yocdev/timer-manager')
const { createHttpTerminator } = require('@yocdev/http-terminator')


// eslint-disable-next-line no-empty-function
const NOOP = () => {}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

class Dependency {
  constructor(name) {
    this._name = name
    this._ready = false
    this._onReady = undefined
    this._onShutdown = undefined
  }

  get name() {
    return this._name
  }

  isReady() {
    return this._ready
  }

  setReady() {
    this._ready = true
    if (typeof this._onReady === 'function') {
      setImmediate(this._onReady.bind(this))
    }
  }

  onReady(callback) {
    this._onReady = callback
  }

  onShutdown(callback) {
    this._onShutdown = callback
  }

  async shutdown() {
    if (typeof this._onShutdown === 'function') {
      await this._onShutdown()
    }
  }
}


const lifecycleShutdownConfigDefaults = {
  signals: ['SIGTERM'],
  serverGracefullyShutdownTimeout: 30000,
  dependenciesShutdownTimeout: 5000,
}

const LifecycleStatics = {
  logger: { info: NOOP, warn: NOOP, error: NOOP },
  onReady: undefined,
  callReady() {
    this.logger.info('Ready.')
    if (typeof this.onReady === 'function') {
      setImmediate(this.onReady.bind(this))
    }
  },
  alive: undefined,
  dependencyMap: new Map(),
  dependencies: [],
  dependenciesCreated: false,
  httpTerminator: null,
  shuttingDown: false,
  shutdownConfig: lifecycleShutdownConfigDefaults,
}

class Lifecycle {
  // eslint-disable-next-line lines-around-comment
  /**
   * @param {Object} logger
   * @param {function} logger.info
   * @param {function} logger.warn
   * @param {function} logger.error
   */
  static setLogger(logger) {
    LifecycleStatics.logger = logger
  }

  /**
   * Create dependencies.
   * Even if your App has no dependencies, you should call this method to
   * let the `Lifecycle.onReady()` be called correctly.
   * Just call `Lifecycle.createDependencies()` if no dependencies needed.
   *
   * @param {(string[]|null|undefined)} dependencyNames
   */
  static createDependencies(dependencyNames) {
    if (LifecycleStatics.dependenciesCreated) {
      throw new Error('Dependencies have created.')
    }
    LifecycleStatics.dependenciesCreated = true

    if (!Array.isArray(dependencyNames) || dependencyNames.length === 0) {
      LifecycleStatics.logger.info('[Dependencies] No dependencies for this Lifecycle.')
      LifecycleStatics.callReady()
      return []
    }

    let readyCount = 0
    dependencyNames.forEach(dependencyName => {
      const dependency = new Dependency(dependencyName)
      dependency.onReady(() => {
        readyCount += 1
        if (readyCount === dependencyNames.length) {
          LifecycleStatics.callReady()
        }
      })
      LifecycleStatics.dependencyMap.set(dependencyName, dependency)
      LifecycleStatics.dependencies.push(dependency)
    })
    LifecycleStatics.logger.info(
      `[Dependencies] ${dependencyNames.length} created (${dependencyNames.join(', ')}).`,
    )
    return LifecycleStatics.dependencies
  }

  static getDependency(dependencyName) {
    const dependency = LifecycleStatics.dependencyMap.get(dependencyName)
    if (!dependency) {
      throw new Error(`[Lifecycle] No dependency found for name \`${dependencyName}\``)
    }
    return dependency
  }

  static isReady() {
    if (LifecycleStatics.dependencies.length === 0) {
      return true
    }
    return LifecycleStatics.dependencies.every(dependency => dependency.isReady())
  }

  static onReady(callback) {
    LifecycleStatics.onReady = callback
  }

  /**
   * If LifecycleStatics.alive is not been set,
   * then use readiness to indicate liveness.
   */
  static isAlive() {
    if (LifecycleStatics.alive === undefined) {
      return this.isReady()
    }
    return LifecycleStatics.alive
  }

  static setAlive() {
    LifecycleStatics.alive = true
  }

  static setDead() {
    LifecycleStatics.alive = false
  }

  static isShuttingDown() {
    return LifecycleStatics.shuttingDown
  }

  /**
   * Shutdown configuration.
   *
   * @param {Object} config - Shutdown configuration.
   * @param {string[]} [signals=['SIGTERM']] - Array of signals to listen for relative to shutdown.
   * @param {number} [config.delay] - Number of milliseconds before beginning the shutdown process.
   *   Needed for HTTP server when traffics are not stopped immediately after process receiving
   *   terminating signal. (e.g. in K8s environment)
   * @param {(http.Server|https.Server)} [config.server] - http.Server or https.Server instance.
   * @param {number} [config.serverGracefullyShutdownTimeout] - Number of milliseconds before
   *   forcibly closing the HTTP server. Will be ignored if `config.server` is not specified.
   * @param {function} [config.onMainComponentShutdown] - Execute right after the `config.delay`
   *   milliseconds if no `config.server` specified. Only needed if your App is not a HTTP server
   *   and has its own (gracefully) shutdown logic. The shutdown logic goes here.
   * @param {number} [config.dependenciesShutdownTimeout] - Number of milliseconds before forcibly
   *   shutting down dependencies. Note: Dependencies shutdown in parallel.
   */
  static configurateShutdown(config) {
    LifecycleStatics.shutdownConfig = {
      ...lifecycleShutdownConfigDefaults,
      ...config,
    }

    const _config = LifecycleStatics.shutdownConfig
    if (_config.server) {
      LifecycleStatics.httpTerminator = createHttpTerminator({
        server: _config.server,
        gracefulTerminationTimeout: _config.serverGracefullyShutdownTimeout,
      })
    }
  }

  static attach() {
    const statics = LifecycleStatics
    const logger = statics.logger
    const dependencyCount = statics.dependencies.length
    const dependencyNamesText = statics
      .dependencies
      .map(dependency => dependency.name)
      .join(', ')
    const dependencyDetailText = dependencyCount === 0
      ? '0 dependencies'
      : `${dependencyCount} dependencies (${dependencyNamesText})`

    statics.shutdownConfig.signals.forEach(signal => process.on(signal, async () => {
      if (statics.shuttingDown) {
        logger.warn(`[Signal:${signal}] Already shutting down. Skipped.`)
        return
      }

      statics.shuttingDown = true
      const config = statics.shutdownConfig

      // Delay if needed.
      if (config.delay) {
        logger.info(`[Delay] Delaying ${config.delay}ms...`)
        await sleep(config.delay)
      }

      // Main component termination.
      try {
        if (statics.httpTerminator) {
          logger.info('[MainComponent] Shutting down HTTP(s) server...')
          await statics.httpTerminator.terminate()
          logger.info('[MainComponent] Shut down.')
        } else if (config.onMainComponentShutdown) {
          logger.info('[MainComponent] Shutting down main component (non HTTP(s) server)...')
          await config.onMainComponentShutdown()
          logger.info('[MainComponent] Shut down.')
        } else {
          logger.info('[MainComponent] None for shutting down. Skipped.')
        }
      } catch (error) {
        logger.warn('[MainComponent] Error shutting down:', error)
      }

      // Dependencies termination.
      if (statics.dependencies.length === 0) {
        logger.info('[Dependencies] None for shutting down. Skipped.')
      } else {
        logger.info(`[Dependencies] Shutting down ${dependencyDetailText}...`)
        let timer
        if (config.dependenciesShutdownTimeout) {
          timer = setTimeout(() => {
            logger.warn(
              '[Dependencies] Timed out shutting down in',
              `${config.dependenciesShutdownTimeout}ms. Forcibly exit.`,
            )
            process.exit(1)
          }, config.dependenciesShutdownTimeout)
        }
        await Promise.all(statics.dependencies.map(dependency => {
          const result = dependency.shutdown()
          if (result.catch) {
            return result.catch(error => {
              logger.warn(`[Dependency:${dependency.name}] Error shutting down:`, error)
            })
          }
          return result
        }))
        if (timer) {
          clearTimeout(timer)
        }
        logger.info('[Dependencies] All shut down.')
      }

      // Clear all timers.
      const timeoutCount = TimerManager.getTimeoutTimerSet().size
      const intervalCount = TimerManager.getIntervalTimerSet().size
      logger.info(
        '[Timers] Clearing timers',
        `(${timeoutCount} timeout type, ${intervalCount} interval type)...`,
      )
      TimerManager.clearAll()
      logger.info('[Timers] All cleared.')

      TimerManager.original.setTimeout(() => {
        logger.warn(
          'Process did not exit on its own.',
          'Investigate what is keeping the event loop active',
          'using packages like `wtfnode` or `why-is-node-running`.',
        )
        process.exit(1)
      }, 1000).unref()
    }))

    const httpMainComponentCount = statics.httpTerminator ? 1 : 0
    const nonHttpMainComponentCount = (
      !statics.httpTerminator &&
      statics.shutdownConfig.onMainComponentShutdown
    )
      ? 1
      : 0
    const mainComponentCount = httpMainComponentCount + nonHttpMainComponentCount
    logger.info(
      'Attached.',
      `${dependencyDetailText}.`,
      `${mainComponentCount} main components`,
      `(${httpMainComponentCount} HTTP(s) servers,`,
      `${nonHttpMainComponentCount} non HTTP(s) servers).`,
    )
  }
}


module.exports = Lifecycle
