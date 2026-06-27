/**
 * SHARED golden corpus for the footnote canonicalizer (issue #228).
 *
 * Each case is { name, input, expected } where `expected` is exactly what
 * `canonicalizeFootnotes(input)` must return. This is the CANONICAL copy; it is
 * mirrored verbatim (data only) in `packages/mcp/test/unit/footnote-corpus.mjs`.
 * Both the editor-ext copy and the MCP mirror of `canonicalizeFootnotes` are run
 * against this corpus by their respective test suites, which turns "the two
 * pure copies behave identically" into a checkable property without coupling the
 * packages. When you change one corpus, change the other.
 *
 * Coverage includes (besides ordering/orphan/reuse/dedup/synth/merge): a single
 * canonical list with NON-EMPTY content after it (must NOT be repositioned —
 * plugin placement parity, must-fix #2), a reference nested inside a callout
 * (the recursive collection, test-coverage #14), and a BARE footnoteDefinition
 * nested in a callout (rebuild must strip the original so it is not duplicated).
 */
export interface FootnoteCorpusCase {
  name: string;
  input: any;
  expected: any;
}

export const FOOTNOTE_CORPUS: FootnoteCorpusCase[] = [
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
    "name": "bare footnoteDefinition nested in a callout is collected, NOT duplicated",
    "input": {
      "type": "doc",
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
                "id": "a"
              }
            }
          ]
        },
        {
          "type": "callout",
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
                      "text": "note A"
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
              "text": "see "
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
          "type": "callout",
          "content": []
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
                      "text": "note A"
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
