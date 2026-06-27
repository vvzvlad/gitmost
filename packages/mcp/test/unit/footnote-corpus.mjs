// MIRROR (data only) of
// packages/editor-ext/src/lib/footnote/footnote-corpus.ts — keep the two in
// sync. Shared golden corpus for the footnote canonicalizer (issue #228): each
// case is { name, input, expected } where `expected` is exactly what
// `canonicalizeFootnotes(input)` must return. Running BOTH the editor-ext copy
// and this MCP mirror against the same corpus makes "the two pure copies behave
// identically" a checkable property without coupling the packages.
export const FOOTNOTE_CORPUS = [
  {
    "name": "out-of-order defs ordered by first reference",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "b"
              }
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "a"
              }
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "d"
              }
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "c"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "a"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "A"
                    }
                  ]
                }
              ]
            },
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "c"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "C"
                    }
                  ]
                }
              ]
            },
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "b"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "B"
                    }
                  ]
                }
              ]
            },
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "d"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "D"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "b"
              }
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "a"
              }
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "d"
              }
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "c"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "b"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "B"
                    }
                  ]
                }
              ]
            },
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "a"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "A"
                    }
                  ]
                }
              ]
            },
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "d"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "D"
                    }
                  ]
                }
              ]
            },
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "c"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "C"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  },
  {
    "name": "orphan definition dropped",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "a"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "a"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "A"
                    }
                  ]
                }
              ]
            },
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "orphan"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "O"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "a"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "a"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "A"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  },
  {
    "name": "no references removes the list",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "plain"
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "orphan"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "O"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "plain"
            }
          ]
        }
      ]
    }
  },
  {
    "name": "reuse: repeated references collapse to one definition",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "d"
              }
            },
            {
              "type": "text",
              "text": " a "
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "d"
              }
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "d"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "d"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "shared"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "d"
              }
            },
            {
              "type": "text",
              "text": " a "
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "d"
              }
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "d"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "d"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "shared"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  },
  {
    "name": "duplicate definitions: first wins",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "d"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "d"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "first"
                    }
                  ]
                }
              ]
            },
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "d"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "second"
                    }
                  ]
                }
              ]
            },
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "d"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "third"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "d"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "d"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "first"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  },
  {
    "name": "synthesizes an empty definition for a reference with none",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "missing"
              }
            }
          ]
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "missing"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "missing"
              },
              "content": [
                {
                  "type": "paragraph"
                }
              ]
            }
          ]
        }
      ]
    }
  },
  {
    "name": "merges multiple footnotesList nodes into one",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "a"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "x"
              }
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "y"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "x"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "X"
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "tail"
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "y"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "Y"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "a"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "x"
              }
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "y"
              }
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "tail"
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "x"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "X"
                    }
                  ]
                }
              ]
            },
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "y"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "Y"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  },
  {
    "name": "single canonical list before a trailing empty paragraph stays put",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "a"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "a"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "A"
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "type": "paragraph"
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "a"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "a"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "A"
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "type": "paragraph"
        }
      ]
    }
  },
  {
    "name": "single canonical list with NON-EMPTY content after it is NOT moved (plugin parity)",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "a"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "a"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "A"
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "epilogue text"
            }
          ]
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "footnoteReference",
              "attrs": {
                "id": "a"
              }
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "a"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "A"
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "epilogue text"
            }
          ]
        }
      ]
    }
  },
  {
    "name": "reference inside a nested container (callout) is collected",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "callout",
          "content": [
            {
              "type": "paragraph",
              "content": [
                {
                  "type": "text",
                  "text": "see "
                },
                {
                  "type": "footnoteReference",
                  "attrs": {
                    "id": "n"
                  }
                }
              ]
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "n"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "note"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "callout",
          "content": [
            {
              "type": "paragraph",
              "content": [
                {
                  "type": "text",
                  "text": "see "
                },
                {
                  "type": "footnoteReference",
                  "attrs": {
                    "id": "n"
                  }
                }
              ]
            }
          ]
        },
        {
          "type": "footnotesList",
          "content": [
            {
              "type": "footnoteDefinition",
              "attrs": {
                "id": "n"
              },
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "note"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  },
  {
    "name": "no footnotes at all is unchanged",
    "input": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "just text"
            }
          ]
        }
      ]
    },
    "expected": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "just text"
            }
          ]
        }
      ]
    }
  }
];
