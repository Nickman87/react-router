import React, { createElement, isValidElement } from 'react';
import warning from 'warning';
import invariant from 'invariant';
import { loopAsync } from './AsyncUtils';
import { createRoutes } from './RouteUtils';
import { getState, getTransitionHooks, getComponents, getRouteParams, createTransitionHook } from './RoutingUtils';
import { routes, component, components, history, location } from './PropTypes';
import RouterContextMixin from './RouterContextMixin';
import ScrollManagementMixin from './ScrollManagementMixin';
import { isLocation } from './Location';
import Transition from './Transition';

var { arrayOf, func, object } = React.PropTypes;

function runTransition(prevState, routes, location, hooks, callback) {
  var transition = new Transition;

  getState(routes, location, function (error, nextState) {
    if (error || nextState == null || transition.isCancelled) {
      callback(error, null, transition);
    } else {
      nextState.location = location;

      var transitionHooks = getTransitionHooks(prevState, nextState);
      if (Array.isArray(hooks))
        transitionHooks.unshift.apply(transitionHooks, hooks);

      loopAsync(transitionHooks.length, (index, next, done) => {
        transitionHooks[index](nextState, transition, (error) => {
          if (error || transition.isCancelled) {
            done(error); // No need to continue.
          } else {
            next();
          }
        });
      }, function (error) {
        if (error || transition.isCancelled) {
          callback(error, null, transition);
        } else {
          getComponents(nextState.branch, function (error, components) {
            if (error || transition.isCancelled) {
              callback(error, null, transition);
            } else {
              nextState.components = components;
              callback(null, nextState, transition);
            }
          });
        }
      });
    }
  });
}

var Router = React.createClass({

  mixins: [ RouterContextMixin, ScrollManagementMixin ],

  statics: {

    /**
     * Runs a transition to the given location using the given routes and
     * transition hooks (optional) and calls callback(error, state, transition)
     * when finished. This is primarily useful for server-side rendering.
     */
    run(routes, location, transitionHooks, callback) {
      if (typeof transitionHooks === 'function') {
        callback = transitionHooks;
        transitionHooks = null;
      }

      invariant(
        typeof callback === 'function',
        'Router.run needs a callback'
      );

      runTransition(null, routes, location, transitionHooks, callback);
    }

  },

  propTypes: {
    createElement: func.isRequired,
    onAbort: func,
    onError: func,
    onUpdate: func,

    // Client-side
    history,
    routes,
    // Routes may also be given as children (JSX)
    children: routes,

    // Server-side
    location,
    branch: routes,
    params: object,
    components: arrayOf(components)
  },

  getDefaultProps() {
    return {
      createElement
    };
  },

  getInitialState() {
    return {
      isTransitioning: false,
      location: null,
      branch: null,
      params: null,
      components: null
    };
  },

  _updateState(location) {
    invariant(
      isLocation(location),
      'A <Router> needs a valid Location'
    );

    var hooks = this.transitionHooks;
    if (hooks)
      hooks = hooks.map(hook => createTransitionHook(hook, this));

    this.setState({ isTransitioning: true });

    runTransition(this.state, this.routes, location, hooks, (error, state, transition) => {
      if (error) {
        this.handleError(error);
      } else if (transition.isCancelled) {
        if (transition.redirectInfo) {
          var { pathname, query, state } = transition.redirectInfo;
          this.replaceWith(pathname, query, state);
        } else {
          invariant(
            this.state.location,
            'You may not abort the initial transition'
          );

          this.handleAbort(transition.abortReason);
        }
      } else if (state == null) {
        warning(false, 'Location "%s" did not match any routes', location.pathname);
      } else {
        this.setState(state, this.props.onUpdate);
      }

      this.setState({ isTransitioning: false });
    });
  },

  /**
   * Adds a transition hook that runs before all route hooks in a
   * transition. The signature is the same as route transition hooks.
   */
  addTransitionHook(hook) {
    if (!this.transitionHooks)
      this.transitionHooks = [];

    this.transitionHooks.push(hook);
  },

  /**
   * Removes the given transition hook.
   */
  removeTransitionHook(hook) {
    if (this.transitionHooks)
      this.transitionHooks = this.transitionHooks.filter(h => h !== hook);
  },

  handleAbort(reason) {
    if (this.props.onAbort) {
      this.props.onAbort.call(this, reason);
    } else {
      // The best we can do here is goBack so the location state reverts
      // to what it was. However, we also set a flag so that we know not
      // to run through _updateState again since state did not change.
      this._ignoreNextHistoryChange = true;
      this.goBack();
    }
  },

  handleError(error) {
    if (this.props.onError) {
      this.props.onError.call(this, error);
    } else {
      // Throw errors by default so we don't silently swallow them!
      throw error; // This error probably originated in getChildRoutes or getComponents.
    }
  },

  handleHistoryChange() {
    if (this._ignoreNextHistoryChange) {
      this._ignoreNextHistoryChange = false;
    } else {
      this._updateState(this.props.history.location);
    }
  },

  componentWillMount() {
    var { history, routes, children, location, branch, params, components } = this.props;

    if (history) {
      invariant(
        routes || children,
        'Client-side <Router>s need routes. Try using <Router routes> or ' +
        'passing your routes as nested <Route> children'
      );

      this.routes = createRoutes(routes || children);

      if (typeof history.setup === 'function')
        history.setup();

      // We need to listen first in case we redirect immediately.
      if (history.addChangeListener)
        history.addChangeListener(this.handleHistoryChange);

      this._updateState(history.location);
    } else {
      invariant(
        location && branch && params && components,
        'Server-side <Router>s need location, branch, params, and components ' +
        'props. Try using Router.run to get all the props you need'
      );

      this.setState({ location, branch, params, components });
    }
  },

  componentWillReceiveProps(nextProps) {
    invariant(
      this.props.history === nextProps.history,
      '<Router history> may not be changed'
    );

    if (nextProps.history) {
      var currentRoutes = this.props.routes || this.props.children;
      var nextRoutes = nextProps.routes || nextProps.children;

      if (currentRoutes !== nextRoutes) {
        this.routes = createRoutes(nextRoutes);

        // Call this here because _updateState
        // uses this.routes to determine state.
        if (nextProps.history.location)
          this._updateState(nextProps.history.location);
      }
    }
  },

  componentWillUnmount() {
    var { history } = this.props;

    if (history && history.removeChangeListener)
      history.removeChangeListener(this.handleHistoryChange);
  },

  _createElement(component, props) {
    return typeof component === 'function' ? this.props.createElement(component, props) : null;
  },

  _createParentComponentsEntry(newComponents, props) {
    var result = {};

    for (var key in newComponents) {
      if (newComponents.hasOwnProperty(key)) {
        var isElement = typeof newComponents[key] === 'function';

        if (isElement) {
          result[key] = this._createElement(newComponents[key], props);
        } else {
          result[key] = this._createParentComponentsEntry(newComponents[key], props);
        }
      }
    }

    return result;
  },

  _applyParentComponents(props, parentComponents) {
    if (typeof parentComponents === 'undefined')
      return;

    for (var key in parentComponents) {
      if (parentComponents.hasOwnProperty(key)) {
        var newComponent = parentComponents[key];

        if (isValidElement(newComponent)) {
          //Just set the new component on the props
          props[key] = newComponent;
        } else {
          if (!props.hasOwnProperty(key))
            props[key] = {}; //Prepare an empty object

          if (isValidElement(props[key])) {
            //Clone the element and inject the nex properties
            props[key] = React.cloneElement(props[key], newComponent);
          } else {
            this._applyParentComponents(props[key], newComponent);
          }
        }
      }
    }
  },

  render() {
    var { branch, params, components } = this.state;
    var element = null;
    var parentComponentsCache = [];

    if (components) {
      element = components.reduceRight((element, components, index) => {
        //Calculate route specific information to build the props
        var route = branch[index];
        var routeParams = getRouteParams(route, params);
        var props = Object.assign({}, this.state, { route, routeParams });

        //Check if parent components were defined in this route
        if (route.hasOwnProperty('parent_components'))
          parentComponentsCache.unshift(this._createParentComponentsEntry(route['parent_components'], props));

        //Do we have any components for this route?
        if (components == null)
          return element; // Don't create new children; use the grandchildren.

        //If the child element is a valid element, add it to our children
        if (isValidElement(element)) {
          props.children = element;
        } else if (element) { //It is not a single element, but multiple, add them to the props
          // In render, do var { header, sidebar } = this.props;
          Object.assign(props, element);
        }

        //Make sure to add any parentcomponents to the props
        for (var i = 0; i < parentComponentsCache.length; ++i) {
          if (parentComponentsCache[i].hasOwnProperty(route['name']))
          {
            var parentComponents = parentComponentsCache[i][route['name']];

            this._applyParentComponents(props, parentComponents);
          }
        }

        if (typeof components === 'function') {
          //We have a single component, create the element and return it for the next parent
          return this._createElement(components, props);
        } else {
          //We have multiple components, make sure we create all elements and return them for the next parent
          var elements = { children: props.children };
          //Remove the children from the props, we want to pass them along to our parent as children
          delete props.children;
          //Create all elements for the given components
          for (var key in components) {
            if (components.hasOwnProperty(key)) {
              elements[key] = this._createElement(components[key], props);
            }
          }
          //Return the elements for the next parent
          return elements;
        }
      }, element);
    }

    invariant(
      element === null || element === false || isValidElement(element),
      'The root route must render a single element'
    );

    return element;
  }

});

export default Router;
