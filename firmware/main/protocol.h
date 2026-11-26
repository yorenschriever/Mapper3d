#pragma once

#include <stdbool.h>
#include <stdint.h>

#define MAPPER_PROTOCOL_VERSION 2
#define MAPPER_MAX_LEDS 10000
#define MAPPER_INDEX_SYMBOLS 10
#define MAPPER_COUNT_SYMBOLS 4
#define MAPPER_CODE_WORDS (MAPPER_INDEX_SYMBOLS + MAPPER_COUNT_SYMBOLS)
#define MAPPER_FRAME_SYMBOLS 28
#define MAPPER_COLORS 5

/*
 * Each LED repeats a frame of 28 colors (red, green, blue, yellow, magenta = 0..4).
 * Two colors form one symbol of GF(23): value = 5 * first + second, always below 23.
 * The first 10 symbols are the LED index, the last 4 the LED count. Each word is a
 * Reed-Solomon evaluation of a 3-digit base-23 number at x = 1, 2, 3, ..., plus a fixed offset per symbol.
 */
bool mapper_encode(uint16_t index, uint16_t count, uint8_t words[MAPPER_CODE_WORDS]);
uint8_t mapper_frame_symbol(const uint8_t words[MAPPER_CODE_WORDS], unsigned int position);
