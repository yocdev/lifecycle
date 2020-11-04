# lifecycle
Readiness, liveness, gracefully shutdown helpers for server app. Especially suitable for Kubernetes apps.

![Node.js Package](https://github.com/yocdev/lifecycle/workflows/Node.js%20Package/badge.svg)


## Installation

```
$ npm install @yocdev/lifecycle
```


## Usage

```javascript
// --- Initialization
Lifecycle = require('@yocdev/lifecycle')
// Set logger to output debug messages.
// logger should have shape: { info, warn, error }.
Lifecycle.setLogger(console)
// When Lifecycle dependencies are ready, start the App.
Lifecycle.onReady(startApp)

// ...


// --- Create dependencies
// Lifecycle uses dependencies to manage App start and shutdown processes:
// Lifecycle will become ready when all dependencies are ready and
// will shutdown all dependencies when App is going to terminate.

// Create two dependencies.
const [dbDependency, cacheDependency] = Lifecycle.createDependencies(['db', 'cache'])
// Configurate these dependencies.
onDbReady(() => dbDependency.setReady())
dbDependency.onShutdown(() => closeDbConnections())
onCacheReady(() => cacheDependency.setReady())
cacheDependency.onShutdown(() => closeCacheConnections())

// If your App has no dependencies, use `Lifecycle.markNoDependencies()`:
// This is necessary to let Lifecycle become ready immediately.
Lifecycle.markNoDependencies()

// ...


// --- Configurate shutdown and attach

function startApp() {
  // Start HTTP(s) server whatever...
  const server = http.createServer(/* ... */)
  // Express or Koa app.
  // const server = app.listen(...)

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
  Lifecycle.configurateShutdown({
    // In K8s environment and such, it's important to delay shutting down the App,
    // since the traffics are not stopped immediately even when the Pod received
    // terminating signals.
    delay: 5000,
    server,
    serverGracefullyShutdownTimeout: 30000,
    dependenciesShutdownTimeout: 5000,
  })

  // If your App is not a HTTP(s) server and has it's own (gracefully) shutdown process,
  // use `config.onMainComponentShutdown`
  Lifecycle.configurateShutdown({
    onMainComponentShutdown: () => shutdownAppGracefully(),
  })

  // Attach to listen termination signals (e.g. SIGTERM)
  Lifecycle.attach()
}

// ...


// --- Readiness, liveness routes (optional)
app.get('/readiness', (req, res) => {
  res.sendStatus(Lifecycle.isReady() ? 200 : 503)
})
app.get('/liveness', (req, res) => {
  res.sendStatus(Lifecycle.isAlive() ? 200 : 503)
})
```


## API

```yaml
Lifecycle
  - setLogger(logger)
  - createDependencies(dependencyNames)
  - markNoDependencies()
  - getDependency(dependencyName)
  - isReady()
  - onReady(callback)
  - isAlive()
  - setAlive()
  - setDead()
  - isShuttingDown()
  - configurateShutdown(config)
  - attach

Dependency
  - name
  - setReady()
  - onShutdown(callback)
```


## Best practices for gracefully shutdown in Kubernetes

1. Delay shutting down the Pod.
2. Leave readiness probe alone. Not necessarily need a failing on readiness probe.

References:
- https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#when-should-you-use-liveness-or-readiness-probes
> Note that if you just want to be able to drain requests when the Pod is deleted, you do not necessarily need a readiness probe; on deletion, the Pod automatically puts itself into an unready state regardless of whether the readiness probe exists. The Pod remains in the unready state while it waits for the Containers in the Pod to stop.
- https://freecontent.manning.com/handling-client-requests-properly-with-kubernetes/


## Alternates

### terminus

> https://github.com/godaddy/terminus
>
> @4.4.1

Cons:
- Gracefully shutdown feature is base on `stoppable` whose last commit is on Oct 4, 2019.
- Only works with HTTP(s) server type App.
- Failing the readiness probe when shutting down (not necessarily). (Issue: https://github.com/godaddy/terminus/issues/112)

### lightship

> https://github.com/gajus/lightship
>
> @6.2.1

Cons:
- Only works with HTTP(s) server type App.
- Gracefully shutdown may not work as expected. `lightship` creates a separated `health` server and the gracefully shutdown is applied on this server not the business one. (Issue: https://github.com/gajus/lightship/issues/27)
