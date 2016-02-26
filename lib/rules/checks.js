// Use http://astexplorer.net/ to make sense of JS ASTs

checks = function(context) {

  var dot = Npm.require("dot-get");
  var _ = Npm.require("lodash");

  var methods = {};
  var publications = {};
  var secureMethods = {};
  var securePublications = {};

  function addMethod(node) {
    if (dot.get(node, "arguments.0.properties")) {
      node.arguments[0].properties.map(function(methodNode) {
        methods[methodNode.key.name || methodNode.key.value] = methodNode.value;
      });
    }
  }

  function addPublication(node) {
    if (node.arguments.length) {
      publications[node.arguments[0].value] = node.arguments[1];
    }
  }

  function addSecureMethod(node) {
    if (node.arguments.length) {
      secureMethods[node.arguments[0].value] = node.arguments[1];
    }
  }

  function addSecurePublication(node) {
    if (node.arguments.length) {
      securePublications[node.arguments[0].value] = node.arguments[1];
    }
  }

  function getFunctionParams(func) {
    return (func.params || []).filter(function(param) {
        return param.type == "Identifier";
      }).map(function(param) {
        return param.name;
      });
  }

  function buildCheckMap(body) {
    return (body || []).reduce(function check(checkMap, node) {
      if (!node) {
        return checkMap;
      }
      switch (node.type) {
        case "CallExpression":
          if (dot.get(node, "callee.name") == "check" &&
              dot.get(node, "arguments.length")) {
            checkMap[node.arguments[0].name] = true;
          }
          break;
        case "ExpressionStatement":
          check(checkMap, node.expression);
          break;
        case "BlockStatement":
          (node.body || []).reduce(check, checkMap);
          break;
        case "IfStatement":
          check(checkMap, node.test)
          break;
        case "SequenceExpression":
          (node.expressions || []).reduce(check, checkMap);
          break;
        case "BinaryExpression":
          // Should we do this?
          // Short circuiting can produce false negatives
          // e.g.:
          //   true || check(foo, String)
          check(checkMap, node.left);
          check(checkMap, node.right);
          break;
        case "VariableDeclaration":
          (node.declarations || []).reduce(check, checkMap);
          break;
        case "VariableDeclarator":
          check(checkMap, node.init);
          break;
      }
      return checkMap;
    }, {});
  }

  function reportMissingChecks(name, type, node, params, checkMap) {
    params.map(function(param) {
      if (!checkMap[param]) {
        context.report(node.parent, type + " \"" + name + "\" has an unchecked argument: '" + param + "'");
      }
    });
  }

  function checkChecks(type, map) {
    for (var name in map) {
      var node = map[name];
      var params = getFunctionParams(node);
      var body = dot.get(node, "body.body");
      var checkMap = buildCheckMap(body);
      reportMissingChecks(name, type, node, params, checkMap);
    }
  }

  function checkSecures(type, map) {
    for (var name in map) {
      var node = map[name];
      var check = _.find(node.properties, function(property) {
        return dot.get(property, "key.name") == "check";
      });
      var action = _.find(node.properties, function(property) {
        return dot.get(property, "key.name") == (type == "Method" ? "method" : "find");
      });

      var getParamName = function(param) {
        return param.name || dot.get(param, "left.name");
      };
      var checkParams = _.map(dot.get(check, "value.params"), getParamName);
      var actionParams = _.map(dot.get(action, "value.params"), getParamName);

      _.zip(checkParams, actionParams)
      .map(function(pair) {
        return pair[0] === pair[1] ? null : pair;
      })
      .filter(_.identity)
      .map(function(pair) {
        if (pair[0] && pair[1]) {
          context.report(action, "Expected argument '" + pair[1] + "' to match the check argument '" + pair[0] + "'.");
        }
        else if (pair[0]) {
          context.report(action, "Checked argument '" + pair[0] + "' is not being used in the " + (type == "Method" ? "method" : "publication") + ".");
        }
        else {
          context.report(action, "The '" + pair[1] + "' argument is not being checked.");
        }
      });

      var body = dot.get(check, "value.body.body");
      var checkMap = buildCheckMap(body);
      reportMissingChecks(name, type, node, checkParams, checkMap);
    }
  }

  return {
    "CallExpression": function(node) {
      if (dot.get(node, "callee.object.name") == "Meteor") {
        switch (dot.get(node, "callee.property.name")) {
          case "methods": addMethod(node); break;
          case "publish": addPublication(node); break;
        }
      }
      else if (dot.get(node, "callee.object.object.name") == "App" &&
               dot.get(node, "callee.object.property.name") == "Secure") {
        switch (dot.get(node, "callee.property.name")) {
          case "method": addSecureMethod(node); break;
          case "publish": addSecurePublication(node); break;
        }
      }
    },
    "Program:exit": function() {
      checkChecks("Publication", publications);
      checkChecks("Method", methods);
      checkSecures("Publication", securePublications);
      checkSecures("Method", secureMethods);
    }
  };
};
