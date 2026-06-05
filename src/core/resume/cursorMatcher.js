function matchesCursor(relativePath, cursor) {
  if (!cursor) {
    return false;
  }

  return cursor.relativePath === relativePath;
}

module.exports = {
  matchesCursor
};
