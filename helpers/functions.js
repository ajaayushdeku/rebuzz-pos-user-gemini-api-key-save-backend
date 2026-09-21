// Same helper as khajaGharBackend/helpers/functions.js, so models written here
// move across unchanged.
module.exports = {
  pick:
    (...props) =>
    (o) =>
      props.reduce((a, e) => ({ ...a, [e]: o[e] }), {}),
};
