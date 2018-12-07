import { Controller, Ease, Stepper } from './Controller.js'
import { extend, register } from '../utils/adopter.js'
import { from, to } from '../modules/core/gradiented.js'
import { getOrigin } from '../utils/utils.js'
import { noop, timeline } from '../modules/core/defaults.js'
import { registerMethods } from '../utils/methods.js'
import { rx, ry } from '../modules/core/circled.js'
import Animator from './Animator.js'
import Box from '../types/Box.js'
import EventTarget from '../types/EventTarget.js'
import Matrix from '../types/Matrix.js'
import Morphable, { TransformBag } from './Morphable.js'
import Point from '../types/Point.js'
import SVGNumber from '../types/SVGNumber.js'
import Timeline from './Timeline.js'

export default class Runner extends EventTarget {
  constructor (options) {
    super()

    // Store a unique id on the runner, so that we can identify it later
    this.id = Runner.id++

    // Ensure a default value
    options = options == null
      ? timeline.duration
      : options

    // Ensure that we get a controller
    options = typeof options === 'function'
      ? new Controller(options)
      : options

    // Declare all of the variables
    this._element = null
    this._timeline = null
    this.done = false
    this._queue = []

    // Work out the stepper and the duration
    this._duration = typeof options === 'number' && options
    this._isDeclarative = options instanceof Controller
    this._stepper = this._isDeclarative ? options : new Ease()

    // We copy the current values from the timeline because they can change
    this._history = {}

    // Store the state of the runner
    this.enabled = true
    this._time = 0
    this._lastTime = 0

    // At creation, the runner is in reseted state
    this._reseted = true

    // Save transforms applied to this runner
    this.transforms = new Matrix()
    this.transformId = 1

    // Looping variables
    this._haveReversed = false
    this._reverse = false
    this._loopsDone = 0
    this._swing = false
    this._wait = 0
    this._times = 1

    this._frameId = null

    // Stores how long a runner is stored after beeing done
    this._persist = this._isDeclarative ? true : null
  }

  /*
  Runner Definitions
  ==================
  These methods help us define the runtime behaviour of the Runner or they
  help us make new runners from the current runner
  */

  element (element) {
    if (element == null) return this._element
    this._element = element
    element._prepareRunner()
    return this
  }

  timeline (timeline) {
    // check explicitly for undefined so we can set the timeline to null
    if (typeof timeline === 'undefined') return this._timeline
    this._timeline = timeline
    return this
  }

  animate (duration, delay, when) {
    var o = Runner.sanitise(duration, delay, when)
    var runner = new Runner(o.duration)
    if (this._timeline) runner.timeline(this._timeline)
    if (this._element) runner.element(this._element)
    return runner.loop(o).schedule(delay, when)
  }

  schedule (timeline, delay, when) {
    // The user doesn't need to pass a timeline if we already have one
    if (!(timeline instanceof Timeline)) {
      when = delay
      delay = timeline
      timeline = this.timeline()
    }

    // If there is no timeline, yell at the user...
    if (!timeline) {
      throw Error('Runner cannot be scheduled without timeline')
    }

    // Schedule the runner on the timeline provided
    timeline.schedule(this, delay, when)
    return this
  }

  unschedule () {
    var timeline = this.timeline()
    timeline && timeline.unschedule(this)
    return this
  }

  loop (times, swing, wait) {
    // Deal with the user passing in an object
    if (typeof times === 'object') {
      swing = times.swing
      wait = times.wait
      times = times.times
    }

    // Sanitise the values and store them
    this._times = times || Infinity
    this._swing = swing || false
    this._wait = wait || 0
    return this
  }

  delay (delay) {
    return this.animate(0, delay)
  }

  /*
  Basic Functionality
  ===================
  These methods allow us to attach basic functions to the runner directly
  */

  queue (initFn, runFn, retargetFn, isTransform) {
    this._queue.push({
      initialiser: initFn || noop,
      runner: runFn || noop,
      retarget: retargetFn,
      isTransform: isTransform,
      initialised: false,
      finished: false
    })
    var timeline = this.timeline()
    timeline && this.timeline()._continue()
    return this
  }

  during (fn) {
    return this.queue(null, fn)
  }

  after (fn) {
    return this.on('finished', fn)
  }

  /*
  Runner animation methods
  ========================
  Control how the animation plays
  */

  time (time) {
    if (time == null) {
      return this._time
    }
    let dt = time - this._time
    this.step(dt)
    return this
  }

  duration () {
    return this._times * (this._wait + this._duration) - this._wait
  }

  loops (p) {
    var loopDuration = this._duration + this._wait
    if (p == null) {
      var loopsDone = Math.floor(this._time / loopDuration)
      var relativeTime = (this._time - loopsDone * loopDuration)
      var position = relativeTime / this._duration
      return Math.min(loopsDone + position, this._times)
    }
    var whole = Math.floor(p)
    var partial = p % 1
    var time = loopDuration * whole + this._duration * partial
    return this.time(time)
  }

  persist (dtOrForever) {
    if (dtOrForever == null) return this._persist
    this._persist = dtOrForever
    return this
  }

  position (p) {
    // Get all of the variables we need
    var x = this._time
    var d = this._duration
    var w = this._wait
    var t = this._times
    var s = this._swing
    var r = this._reverse
    var position

    if (p == null) {
      /*
      This function converts a time to a position in the range [0, 1]
      The full explanation can be found in this desmos demonstration
        https://www.desmos.com/calculator/u4fbavgche
      The logic is slightly simplified here because we can use booleans
      */

      // Figure out the value without thinking about the start or end time
      const f = function (x) {
        var swinging = s * Math.floor(x % (2 * (w + d)) / (w + d))
        var backwards = (swinging && !r) || (!swinging && r)
        var uncliped = Math.pow(-1, backwards) * (x % (w + d)) / d + backwards
        var clipped = Math.max(Math.min(uncliped, 1), 0)
        return clipped
      }

      // Figure out the value by incorporating the start time
      var endTime = t * (w + d) - w
      position = x <= 0 ? Math.round(f(1e-5))
        : x < endTime ? f(x)
        : Math.round(f(endTime - 1e-5))
      return position
    }

    // Work out the loops done and add the position to the loops done
    var loopsDone = Math.floor(this.loops())
    var swingForward = s && (loopsDone % 2 === 0)
    var forwards = (swingForward && !r) || (r && swingForward)
    position = loopsDone + (forwards ? p : 1 - p)
    return this.loops(position)
  }

  progress (p) {
    if (p == null) {
      return Math.min(1, this._time / this.duration())
    }
    return this.time(p * this.duration())
  }

  step (dt) {
    // If we are inactive, this stepper just gets skipped
    if (!this.enabled) return this

    // Update the time and get the new position
    dt = dt == null ? 16 : dt
    this._time += dt
    var position = this.position()

    // Figure out if we need to run the stepper in this frame
    var running = this._lastPosition !== position && this._time >= 0
    this._lastPosition = position

    // Figure out if we just started
    var duration = this.duration()
    var justStarted = this._lastTime <= 0 && this._time > 0
    var justFinished = this._lastTime < duration && this._time >= duration

    this._lastTime = this._time
    if (justStarted) {
      this.fire('start', this)
    }

    // Work out if the runner is finished set the done flag here so animations
    // know, that they are running in the last step (this is good for
    // transformations which can be merged)
    var declarative = this._isDeclarative
    this.done = !declarative && !justFinished && this._time >= duration

    // Runner is running. So its not in reseted state anymore
    this._reseted = false

    // Call initialise and the run function
    if (running || declarative) {
      this._initialise(running)

      // clear the transforms on this runner so they dont get added again and again
      this.transforms = new Matrix()
      var converged = this._run(declarative ? dt : position)

      this.fire('step', this)
    }
    // correct the done flag here
    // declaritive animations itself know when they converged
    this.done = this.done || (converged && declarative)
    if (justFinished) {
      this.fire('finished', this)
    }
    return this
  }

  reset () {
    if (this._reseted) return this
    this.time(0)
    this._reseted = true
    return this
  }

  finish () {
    return this.step(Infinity)
  }

  reverse (reverse) {
    this._reverse = reverse == null ? !this._reverse : reverse
    return this
  }

  ease (fn) {
    this._stepper = new Ease(fn)
    return this
  }

  active (enabled) {
    if (enabled == null) return this.enabled
    this.enabled = enabled
    return this
  }

  /*
  Private Methods
  ===============
  Methods that shouldn't be used externally
  */

  // Save a morpher to the morpher list so that we can retarget it later
  _rememberMorpher (method, morpher) {
    this._history[method] = {
      morpher: morpher,
      caller: this._queue[this._queue.length - 1]
    }

    // We have to resume the timeline in case a controller
    // is already done without beeing ever run
    // This can happen when e.g. this is done:
    //    anim = el.animate(new SVG.Spring)
    // and later
    //    anim.move(...)
    if (this._isDeclarative) {
      var timeline = this.timeline()
      timeline && timeline.play()
    }
  }

  // Try to set the target for a morpher if the morpher exists, otherwise
  // do nothing and return false
  _tryRetarget (method, target, extra) {
    if (this._history[method]) {
      // if the last method wasnt even initialised, throw it away
      if (!this._history[method].caller.initialised) {
        let index = this._queue.indexOf(this._history[method].caller)
        this._queue.splice(index, 1)
        return false
      }

      // for the case of transformations, we use the special retarget function
      // which has access to the outer scope
      if (this._history[method].caller.retarget) {
        this._history[method].caller.retarget(target, extra)
        // for everything else a simple morpher change is sufficient
      } else {
        this._history[method].morpher.to(target)
      }

      this._history[method].caller.finished = false
      var timeline = this.timeline()
      timeline && timeline.play()
      return true
    }
    return false
  }

  // Run each initialise function in the runner if required
  _initialise (running) {
    // If we aren't running, we shouldn't initialise when not declarative
    if (!running && !this._isDeclarative) return

    // Loop through all of the initialisers
    for (var i = 0, len = this._queue.length; i < len; ++i) {
      // Get the current initialiser
      var current = this._queue[i]

      // Determine whether we need to initialise
      var needsIt = this._isDeclarative || (!current.initialised && running)
      running = !current.finished

      // Call the initialiser if we need to
      if (needsIt && running) {
        current.initialiser.call(this)
        current.initialised = true
      }
    }
  }

  // Run each run function for the position or dt given
  _run (positionOrDt) {
    // Run all of the _queue directly
    var allfinished = true
    for (var i = 0, len = this._queue.length; i < len; ++i) {
      // Get the current function to run
      var current = this._queue[i]

      // Run the function if its not finished, we keep track of the finished
      // flag for the sake of declarative _queue
      var converged = current.runner.call(this, positionOrDt)
      current.finished = current.finished || (converged === true)
      allfinished = allfinished && current.finished
    }

    // We report when all of the constructors are finished
    return allfinished
  }

  addTransform (transform, index) {
    this.transforms.lmultiplyO(transform)
    return this
  }

  clearTransform () {
    this.transforms = new Matrix()
    return this
  }

  // TODO: Keep track of all transformations so that deletion is faster
  clearTransformsFromQueue () {
    if (!this.done || !this._timeline || !this._timeline._runnerIds.includes(this.id)) {
      this._queue = this._queue.filter((item) => {
        return !item.isTransform
      })
    }
  }

  static sanitise (duration, delay, when) {
    // Initialise the default parameters
    var times = 1
    var swing = false
    var wait = 0
    duration = duration || timeline.duration
    delay = delay || timeline.delay
    when = when || 'last'

    // If we have an object, unpack the values
    if (typeof duration === 'object' && !(duration instanceof Stepper)) {
      delay = duration.delay || delay
      when = duration.when || when
      swing = duration.swing || swing
      times = duration.times || times
      wait = duration.wait || wait
      duration = duration.duration || timeline.duration
    }

    return {
      duration: duration,
      delay: delay,
      swing: swing,
      times: times,
      wait: wait,
      when: when
    }
  }
}

Runner.id = 0

class FakeRunner {
  constructor (transforms = new Matrix(), id = -1, done = true) {
    this.transforms = transforms
    this.id = id
    this.done = done
  }

  clearTransformsFromQueue () { }
}

extend([ Runner, FakeRunner ], {
  mergeWith (runner) {
    return new FakeRunner(
      runner.transforms.lmultiply(this.transforms),
      runner.id
    )
  }
})

// FakeRunner.emptyRunner = new FakeRunner()

const lmultiply = (last, curr) => last.lmultiplyO(curr)
const getRunnerTransform = (runner) => runner.transforms

function mergeTransforms () {
  // Find the matrix to apply to the element and apply it
  let runners = this._transformationRunners.runners
  let netTransform = runners
    .map(getRunnerTransform)
    .reduce(lmultiply, new Matrix())

  this.transform(netTransform)

  this._transformationRunners.merge()

  if (this._transformationRunners.length() === 1) {
    this._frameId = null
  }
}

class RunnerArray {
  constructor () {
    this.runners = []
    this.ids = []
  }

  add (runner) {
    if (this.runners.includes(runner)) return
    let id = runner.id + 1

    this.runners.push(runner)
    this.ids.push(id)

    return this
  }

  getByID (id) {
    return this.runners[this.ids.indexOf(id + 1)]
  }

  remove (id) {
    let index = this.ids.indexOf(id + 1)
    this.ids.splice(index, 1)
    this.runners.splice(index, 1)
    return this
  }

  merge () {
    let lastRunner = null
    this.runners.forEach((runner, i) => {

      const condition = lastRunner
        && runner.done && lastRunner.done
        // don't merge runner when persisted on timeline
        && (!runner._timeline || !runner._timeline._runnerIds.includes(runner.id))
        && (!lastRunner._timeline || !lastRunner._timeline._runnerIds.includes(lastRunner.id))

      if (condition) {
        // the +1 happens in the function
        this.remove(runner.id)
        this.edit(lastRunner.id, runner.mergeWith(lastRunner))
      }

      lastRunner = runner
    })

    return this
  }

  edit (id, newRunner) {
    let index = this.ids.indexOf(id + 1)
    this.ids.splice(index, 1, id + 1)
    this.runners.splice(index, 1, newRunner)
    return this
  }

  length () {
    return this.ids.length
  }

  clearBefore (id) {
    let deleteCnt = this.ids.indexOf(id + 1) || 1
    this.ids.splice(0, deleteCnt, 0)
    this.runners.splice(0, deleteCnt, new FakeRunner())
      .forEach((r) => r.clearTransformsFromQueue())
    return this
  }
}

registerMethods({
  Element: {
    animate (duration, delay, when) {
      var o = Runner.sanitise(duration, delay, when)
      var timeline = this.timeline()
      return new Runner(o.duration)
        .loop(o)
        .element(this)
        .timeline(timeline.play())
        .schedule(delay, when)
    },

    delay (by, when) {
      return this.animate(0, by, when)
    },

    // this function searches for all runners on the element and deletes the ones
    // which run before the current one. This is because absolute transformations
    // overwfrite anything anyway so there is no need to waste time computing
    // other runners
    _clearTransformRunnersBefore (currentRunner) {
      this._transformationRunners.clearBefore(currentRunner.id)
    },

    _currentTransform (current) {
      return this._transformationRunners.runners
        // we need the equal sign here to make sure, that also transformations
        // on the same runner which execute before the current transformation are
        // taken into account
        .filter((runner) => runner.id <= current.id)
        .map(getRunnerTransform)
        .reduce(lmultiply, new Matrix())
    },

    _addRunner (runner) {
      this._transformationRunners.add(runner)

      // Make sure that the runner merge is executed at the very end of
      // all Animator functions. Thats why we use immediate here to execute
      // the merge right after all frames are run
      Animator.cancelImmediate(this._frameId)
      this._frameId = Animator.immediate(mergeTransforms.bind(this))
    },

    _prepareRunner () {
      if (this._frameId == null) {
        this._transformationRunners = new RunnerArray()
          .add(new FakeRunner(new Matrix(this)))
      }
    }
  }
})

extend(Runner, {
  attr (a, v) {
    return this.styleAttr('attr', a, v)
  },

  // Add animatable styles
  css (s, v) {
    return this.styleAttr('css', s, v)
  },

  styleAttr (type, name, val) {
    // apply attributes individually
    if (typeof name === 'object') {
      for (var key in name) {
        this.styleAttr(type, key, name[key])
      }
      return this
    }

    var morpher = new Morphable(this._stepper).to(val)

    this.queue(function () {
      morpher = morpher.from(this.element()[type](name))
    }, function (pos) {
      this.element()[type](name, morpher.at(pos))
      return morpher.done()
    })

    return this
  },

  zoom (level, point) {
    if (this._tryRetarget('zoom', to, point)) return this

    var morpher = new Morphable(this._stepper).to(new SVGNumber(level))

    this.queue(function () {
      morpher = morpher.from(this.element().zoom())
    }, function (pos) {
      this.element().zoom(morpher.at(pos), point)
      return morpher.done()
    }, function (newLevel, newPoint) {
      point = newPoint
      morpher.to(newLevel)
    })

    this._rememberMorpher('zoom', morpher)
    return this
  },

  /**
   ** absolute transformations
   **/

  //
  // M v -----|-----(D M v = F v)------|----->  T v
  //
  // 1. define the final state (T) and decompose it (once)
  //    t = [tx, ty, the, lam, sy, sx]
  // 2. on every frame: pull the current state of all previous transforms
  //    (M - m can change)
  //   and then write this as m = [tx0, ty0, the0, lam0, sy0, sx0]
  // 3. Find the interpolated matrix F(pos) = m + pos * (t - m)
  //   - Note F(0) = M
  //   - Note F(1) = T
  // 4. Now you get the delta matrix as a result: D = F * inv(M)

  transform (transforms, relative, affine) {
    // If we have a declarative function, we should retarget it if possible
    relative = transforms.relative || relative
    if (this._isDeclarative && !relative && this._tryRetarget('transform', transforms)) {
      return this
    }

    // Parse the parameters
    var isMatrix = Matrix.isMatrixLike(transforms)
    affine = transforms.affine != null
      ? transforms.affine
      : (affine != null ? affine : !isMatrix)

    // Create a morepher and set its type
    const morpher = new Morphable(this._stepper)
      .type(affine ? TransformBag : Matrix)

    let origin
    let element
    let current
    let currentAngle
    let startTransform

    function setup () {
      // make sure element and origin is defined
      element = element || this.element()
      origin = origin || getOrigin(transforms, element)

      startTransform = new Matrix(relative ? undefined : element)

      // add the runner to the element so it can merge transformations
      element._addRunner(this)

      // Deactivate all transforms that have run so far if we are absolute
      if (!relative) {
        element._clearTransformRunnersBefore(this)
      }
    }

    function run (pos) {
      // clear all other transforms before this in case something is saved
      // on this runner. We are absolute. We dont need these!
      if (!relative) this.clearTransform()

      let { x, y } = new Point(origin).transform(element._currentTransform(this))

      let target = new Matrix({ ...transforms, origin: [ x, y ] })
      let start = this._isDeclarative && current
        ? current
        : startTransform

      if (affine) {
        target = target.decompose(x, y)
        start = start.decompose(x, y)

        // Get the current and target angle as it was set
        const rTarget = target.rotate
        const rCurrent = start.rotate

        // Figure out the shortest path to rotate directly
        const possibilities = [ rTarget - 360, rTarget, rTarget + 360 ]
        const distances = possibilities.map(a => Math.abs(a - rCurrent))
        const shortest = Math.min(...distances)
        const index = distances.indexOf(shortest)
        target.rotate = possibilities[index]
      }

      if (relative) {
        // we have to be careful here not to overwrite the rotation
        // with the rotate method of Matrix
        if (!isMatrix) {
          target.rotate = transforms.rotate || 0
        }
        if (this._isDeclarative && currentAngle) {
          start.rotate = currentAngle
        }
      }

      morpher.from(start)
      morpher.to(target)

      let affineParameters = morpher.at(pos)
      currentAngle = affineParameters.rotate
      current = new Matrix(affineParameters)

      this.addTransform(current)
      element._addRunner(this)
      return morpher.done()
    }

    function retarget (newTransforms) {
      // only get a new origin if it changed since the last call
      if (
        (newTransforms.origin || 'center').toString()
        !== (transforms.origin || 'center').toString()
      ) {
        origin = getOrigin(transforms, element)
      }

      // overwrite the old transformations with the new ones
      transforms = { ...newTransforms, origin }
    }

    this.queue(setup, run, retarget, true)
    this._isDeclarative && this._rememberMorpher('transform', morpher)
    return this
  },

  // Animatable x-axis
  x (x, relative) {
    return this._queueNumber('x', x)
  },

  // Animatable y-axis
  y (y) {
    return this._queueNumber('y', y)
  },

  dx (x) {
    return this._queueNumberDelta('x', x)
  },

  dy (y) {
    return this._queueNumberDelta('y', y)
  },

  _queueNumberDelta (method, to) {
    to = new SVGNumber(to)

    // Try to change the target if we have this method already registerd
    if (this._tryRetarget(method, to)) return this

    // Make a morpher and queue the animation
    var morpher = new Morphable(this._stepper).to(to)
    var from = null
    this.queue(function () {
      from = this.element()[method]()
      morpher.from(from)
      morpher.to(from + to)
    }, function (pos) {
      this.element()[method](morpher.at(pos))
      return morpher.done()
    }, function (newTo) {
      morpher.to(from + new SVGNumber(newTo))
    })

    // Register the morpher so that if it is changed again, we can retarget it
    this._rememberMorpher(method, morpher)
    return this
  },

  _queueObject (method, to) {
    // Try to change the target if we have this method already registerd
    if (this._tryRetarget(method, to)) return this

    // Make a morpher and queue the animation
    var morpher = new Morphable(this._stepper).to(to)
    this.queue(function () {
      morpher.from(this.element()[method]())
    }, function (pos) {
      this.element()[method](morpher.at(pos))
      return morpher.done()
    })

    // Register the morpher so that if it is changed again, we can retarget it
    this._rememberMorpher(method, morpher)
    return this
  },

  _queueNumber (method, value) {
    return this._queueObject(method, new SVGNumber(value))
  },

  // Animatable center x-axis
  cx (x) {
    return this._queueNumber('cx', x)
  },

  // Animatable center y-axis
  cy (y) {
    return this._queueNumber('cy', y)
  },

  // Add animatable move
  move (x, y) {
    return this.x(x).y(y)
  },

  // Add animatable center
  center (x, y) {
    return this.cx(x).cy(y)
  },

  // Add animatable size
  size (width, height) {
    // animate bbox based size for all other elements
    var box

    if (!width || !height) {
      box = this._element.bbox()
    }

    if (!width) {
      width = box.width / box.height * height
    }

    if (!height) {
      height = box.height / box.width * width
    }

    return this
      .width(width)
      .height(height)
  },

  // Add animatable width
  width (width) {
    return this._queueNumber('width', width)
  },

  // Add animatable height
  height (height) {
    return this._queueNumber('height', height)
  },

  // Add animatable plot
  plot (a, b, c, d) {
    // Lines can be plotted with 4 arguments
    if (arguments.length === 4) {
      return this.plot([ a, b, c, d ])
    }

    if (this._tryRetarget('plot', a)) return this

    var morpher = new Morphable(this._stepper)
      .type(this._element.MorphArray).to(a)

    this.queue(function () {
      morpher.from(this._element.array())
    }, function (pos) {
      this._element.plot(morpher.at(pos))
      return morpher.done()
    })

    this._rememberMorpher('plot', morpher)
    return this
  },

  // Add leading method
  leading (value) {
    return this._queueNumber('leading', value)
  },

  // Add animatable viewbox
  viewbox (x, y, width, height) {
    return this._queueObject('viewbox', new Box(x, y, width, height))
  },

  update (o) {
    if (typeof o !== 'object') {
      return this.update({
        offset: arguments[0],
        color: arguments[1],
        opacity: arguments[2]
      })
    }

    if (o.opacity != null) this.attr('stop-opacity', o.opacity)
    if (o.color != null) this.attr('stop-color', o.color)
    if (o.offset != null) this.attr('offset', o.offset)

    return this
  }
})

extend(Runner, { rx, ry, from, to })
register(Runner)
