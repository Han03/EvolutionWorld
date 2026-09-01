# 简单 Makefile（无需 cmake 亦可构建）
CXX ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter
LDFLAGS ?= -lcrypto -lpthread

SRCS := $(wildcard src/*.cpp src/util/*.cpp src/game/*.cpp src/auth/*.cpp src/anticheat/*.cpp src/net/*.cpp)
OBJS := $(SRCS:.cpp=.o)
TARGET := evolution_server

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CXX) $(CXXFLAGS) -o $@ $(OBJS) $(LDFLAGS)

%.o: %.cpp
	$(CXX) $(CXXFLAGS) -Isrc -c $< -o $@

clean:
	rm -f $(OBJS) $(TARGET)

.PHONY: all clean
